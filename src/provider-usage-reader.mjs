import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { codexZeroHome } from "./paths.mjs";

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_CACHED_FILES = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

const readerStates = new Map();
let readsInOrder = Promise.resolve();

function emptySummary(partial = false) {
  return { extraCostUsd: 0, extraUncachedUsd: 0, partial, requests: 0, pricedRequests: 0 };
}

function emptySessionSummary(partial = false) {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
    requests: 0, knownUsageRequests: 0, partial };
}

function createState() {
  return {
    offset: 0,
    identity: null,
    mtimeMs: null,
    pendingLine: Buffer.alloc(0),
    discardUntilNewline: false,
    globalPartial: false,
    summaries: new Map(),
    sessionSummaries: new Map(),
    seenRequests: new Set(),
  };
}

function resetState(state) {
  state.offset = 0;
  state.identity = null;
  state.mtimeMs = null;
  state.pendingLine = Buffer.alloc(0);
  state.discardUntilNewline = false;
  state.globalPartial = false;
  state.summaries.clear();
  state.sessionSummaries.clear();
  state.seenRequests.clear();
}

function stateFor(file) {
  let state = readerStates.get(file);
  if (state) {
    readerStates.delete(file);
    readerStates.set(file, state);
    return state;
  }
  if (readerStates.size >= MAX_CACHED_FILES) readerStates.delete(readerStates.keys().next().value);
  state = createState();
  readerStates.set(file, state);
  return state;
}

function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function summaryFor(state, threadId, session = false) {
  const summary = session ? state.sessionSummaries.get(threadId) ?? emptySessionSummary()
    : state.summaries.get(threadId) ?? emptySummary();
  return { ...summary, partial: summary.partial || state.globalPartial };
}

function validUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { input_tokens: input, output_tokens: output, total_tokens: total } = value;
  const cached = value.input_tokens_details?.cached_tokens;
  const writes = value.input_tokens_details?.cache_write_tokens;
  const reasoning = value.output_tokens_details?.reasoning_tokens;
  return [input, output, total, cached, writes, reasoning].every((count) => Number.isSafeInteger(count) && count >= 0)
    && cached + writes <= input
    && reasoning <= output
    && input + output === total
    && Number.isSafeInteger(input + output);
}

function validEstimate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function increment(summary, field) {
  if (summary[field] >= Number.MAX_SAFE_INTEGER) {
    summary.partial = true;
    return false;
  }
  summary[field] += 1;
  return true;
}

function addEstimates(summary, cost, uncached) {
  const nextCost = summary.extraCostUsd + cost;
  const nextUncached = summary.extraUncachedUsd + uncached;
  if (!Number.isFinite(nextCost) || !Number.isFinite(nextUncached)) {
    summary.partial = true;
    return false;
  }
  summary.extraCostUsd = nextCost;
  summary.extraUncachedUsd = nextUncached;
  return true;
}

function addSessionUsage(summary, usage) {
  const values = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens, totalTokens: usage.total_tokens };
  if (Object.entries(values).some(([key, value]) => !Number.isSafeInteger(summary[key] + value))) {
    summary.partial = true;
    return false;
  }
  for (const [key, value] of Object.entries(values)) summary[key] += value;
  increment(summary, "knownUsageRequests");
  return true;
}

function processMetadata(state, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    state.globalPartial = true;
    return;
  }
  if (row.threadId == null) return;
  if (typeof row.threadId !== "string" || !UUID.test(row.threadId)) {
    state.globalPartial = true;
    return;
  }

  let summary = state.summaries.get(row.threadId);
  if (!summary) {
    summary = emptySummary();
    state.summaries.set(row.threadId, summary);
  }
  let session = state.sessionSummaries.get(row.threadId);
  if (!session) {
    session = emptySessionSummary();
    state.sessionSummaries.set(row.threadId, session);
  }

  if (typeof row.requestId !== "string" || !REQUEST_ID.test(row.requestId)
    || !Number.isSafeInteger(row.attempt) || row.attempt < 1) {
    summary.partial = true;
    session.partial = true;
    return;
  }
  const requestKey = `${row.requestId}\0${row.attempt}`;
  if (state.seenRequests.has(requestKey)) return;
  state.seenRequests.add(requestKey);

  if (row.includedInCoreUsage === true) {
    if (row.usageKnown !== true || !validUsage(row.usage)
      || !validEstimate(row.estimatedCostUsd) || !validEstimate(row.estimatedUncachedCostUsd)) {
      summary.partial = true;
    }
    return;
  }
  if (row.includedInCoreUsage !== false) {
    summary.partial = true;
    session.partial = true;
    return;
  }

  increment(summary, "requests");
  increment(session, "requests");
  if (row.usageKnown === true && validUsage(row.usage)) addSessionUsage(session, row.usage);
  else session.partial = true;
  if (row.usageKnown !== true || !validUsage(row.usage)
    || !validEstimate(row.estimatedCostUsd) || !validEstimate(row.estimatedUncachedCostUsd)) {
    summary.partial = true;
    return;
  }

  if (!addEstimates(summary, row.estimatedCostUsd, row.estimatedUncachedCostUsd)) return;
  increment(summary, "pricedRequests");
}

function processLine(state, bytes) {
  let line = bytes;
  if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
  if (line.length > MAX_LINE_BYTES) {
    state.globalPartial = true;
    return;
  }
  try {
    const text = decoder.decode(line);
    processMetadata(state, JSON.parse(text));
  } catch {
    state.globalPartial = true;
  }
}

function processChunk(state, chunk) {
  let data = state.pendingLine.length ? Buffer.concat([state.pendingLine, chunk]) : chunk;
  state.pendingLine = Buffer.alloc(0);
  let start = 0;

  if (state.discardUntilNewline) {
    const newline = data.indexOf(0x0a);
    if (newline < 0) return;
    start = newline + 1;
    state.discardUntilNewline = false;
  }

  while (start < data.length) {
    const newline = data.indexOf(0x0a, start);
    if (newline < 0) {
      const tail = data.subarray(start);
      if (tail.length > MAX_LINE_BYTES) {
        state.globalPartial = true;
        state.discardUntilNewline = true;
      } else {
        state.pendingLine = Buffer.from(tail);
      }
      return;
    }
    const line = data.subarray(start, newline);
    if (line.length > MAX_LINE_BYTES) state.globalPartial = true;
    else processLine(state, line);
    start = newline + 1;
  }
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function statFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) return { error: new Error("Invalid provider usage file") };
    return { stat };
  } catch (error) {
    return { error };
  }
}

async function readFileIncrementally(file, state) {
  let current = await statFile(file);
  if (current.error) {
    if (isMissing(current.error)) resetState(state);
    else state.globalPartial = true;
    return;
  }

  const before = current.stat;
  const fileIdentity = identity(before);
  const changedWithoutGrowth = state.mtimeMs != null && before.size <= state.offset && before.mtimeMs !== state.mtimeMs;
  if ((state.identity != null && state.identity !== fileIdentity)
    || before.size < state.offset || changedWithoutGrowth) {
    resetState(state);
  }
  state.identity = fileIdentity;
  const scanUntil = before.size;

  let handle;
  try {
    handle = await fs.open(file, "r");
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    while (state.offset < scanUntil) {
      const length = Math.min(CHUNK_BYTES, scanUntil - state.offset);
      const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
      if (bytesRead === 0) break;
      processChunk(state, chunk.subarray(0, bytesRead));
      state.offset += bytesRead;
    }
  } catch {
    state.globalPartial = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  current = await statFile(file);
  if (current.error) {
    if (isMissing(current.error)) resetState(state);
    else state.globalPartial = true;
    return;
  }
  const after = current.stat;
  if (identity(after) !== state.identity || after.size < state.offset
    || (after.size === state.offset && after.size === before.size && after.mtimeMs !== before.mtimeMs)) {
    resetState(state);
    state.identity = identity(after);
  }
  state.mtimeMs = after.mtimeMs;
}

async function readAtPath(file, threadId, session = false) {
  const state = stateFor(file);
  await readFileIncrementally(file, state);
  return summaryFor(state, threadId, session);
}

function readSummary(threadId, { home, environment = process.env } = {}, session = false) {
  if (typeof threadId !== "string" || !UUID.test(threadId)) throw new TypeError("Invalid provider usage threadId");
  const directory = home ?? codexZeroHome(environment);
  if (typeof directory !== "string" || !directory) throw new TypeError("Invalid provider usage home");
  const file = path.resolve(directory, "provider-usage.jsonl");
  const read = readsInOrder.then(() => readAtPath(file, threadId, session));
  readsInOrder = read.catch(() => {});
  return read.then((summary) => ({ ...summary }));
}

export function readUnreportedProviderUsage(threadId, options) {
  return readSummary(threadId, options);
}

/** Supplemental numeric usage only; requests already reported to core are excluded. */
export function readProviderSessionUsage(threadId, options) {
  return readSummary(threadId, options, true);
}
