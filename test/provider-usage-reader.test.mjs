import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProviderSessionUsage, readUnreportedProviderUsage } from "../src/provider-usage-reader.mjs";

const threadId = "0199f6c4-a982-7ac4-918c-805466b2bc47";
const otherThreadId = "0199f6c4-a982-7ac4-918c-805466b2bc48";
const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  output_tokens: 30,
  output_tokens_details: { reasoning_tokens: 4 },
  total_tokens: 130,
};

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    timestamp: "2026-09-30T12:00:00.000Z",
    requestId: "req_1",
    attempt: 1,
    providerId: "glm",
    apiType: "chat",
    threadId,
    status: "completed",
    latencyMs: 100,
    usageKnown: true,
    usage,
    includedInCoreUsage: false,
    estimatedCostUsd: 0.25,
    estimatedUncachedCostUsd: 0.5,
    ...overrides,
  };
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

async function temporaryHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cz-provider-reader-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function append(home, value) {
  await fs.mkdir(home, { recursive: true });
  await fs.appendFile(path.join(home, "provider-usage.jsonl"), value, "utf8");
}

const zero = { extraCostUsd: 0, extraUncachedUsd: 0, partial: false, requests: 0, pricedRequests: 0 };

test("missing and empty ledgers report zero without partial state", async (t) => {
  const home = await temporaryHome(t);
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), zero);
  await fs.writeFile(path.join(home, "provider-usage.jsonl"), "");
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), zero);
});

test("incremental appends and concurrent reads count each unreported request once", async (t) => {
  const home = await temporaryHome(t);
  await append(home, line(record()));
  const summaries = await Promise.all(Array.from({ length: 12 }, () => readUnreportedProviderUsage(threadId, { home })));
  for (const summary of summaries) {
    assert.deepEqual(summary, { extraCostUsd: 0.25, extraUncachedUsd: 0.5, partial: false, requests: 1, pricedRequests: 1 });
  }

  await append(home, line(record()));
  await append(home, line(record({ requestId: "req_2", attempt: 1, estimatedCostUsd: 0.75, estimatedUncachedCostUsd: 1.25 })));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 1, extraUncachedUsd: 1.75, partial: false, requests: 2, pricedRequests: 2,
  });
  assert.deepEqual(await readUnreportedProviderUsage(otherThreadId, { home }), zero);
});

test("keeps an incomplete multibyte UTF-8 line until its newline arrives", async (t) => {
  const home = await temporaryHome(t);
  const content = `${JSON.stringify(record({ note: "🌿 café" }))}\n`;
  const bytes = Buffer.from(content, "utf8");
  const emoji = bytes.indexOf(Buffer.from("🌿", "utf8"));
  assert.ok(emoji > 0);
  await fs.writeFile(path.join(home, "provider-usage.jsonl"), bytes.subarray(0, emoji + 2));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), zero);

  await fs.appendFile(path.join(home, "provider-usage.jsonl"), bytes.subarray(emoji + 2));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 0.25, extraUncachedUsd: 0.5, partial: false, requests: 1, pricedRequests: 1,
  });
});

test("resets totals after truncation and file replacement", async (t) => {
  const home = await temporaryHome(t);
  const file = path.join(home, "provider-usage.jsonl");
  await fs.writeFile(file, line(record({ requestId: "a_long_request_id_before_truncation" })));
  assert.equal((await readUnreportedProviderUsage(threadId, { home })).extraCostUsd, 0.25);

  await fs.writeFile(file, line(record({ requestId: "b", estimatedCostUsd: 0.1, estimatedUncachedCostUsd: 0.2 })));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 0.1, extraUncachedUsd: 0.2, partial: false, requests: 1, pricedRequests: 1,
  });

  const rotated = `${file}.rotated`;
  await fs.rename(file, rotated);
  await fs.writeFile(file, line(record({ requestId: "c", estimatedCostUsd: 0.3, estimatedUncachedCostUsd: 0.4 })));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 0.3, extraUncachedUsd: 0.4, partial: false, requests: 1, pricedRequests: 1,
  });
});

test("unknown usage, missing estimates, and legacy attribution stay partial and unpriced", async (t) => {
  const home = await temporaryHome(t);
  await append(home, line(record({ requestId: "unknown_usage", usageKnown: false, usage: null,
    estimatedCostUsd: 0, estimatedUncachedCostUsd: 0 })));
  await append(home, line(record({ requestId: "missing_price", estimatedCostUsd: null })));
  await append(home, line(record({ requestId: "core_unknown_price", includedInCoreUsage: true, estimatedUncachedCostUsd: null })));
  await append(home, line(record({ requestId: "legacy", includedInCoreUsage: null })));

  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 0, extraUncachedUsd: 0, partial: true, requests: 2, pricedRequests: 0,
  });
});

test("excludes the final reply already reported to core and sums internal calls exactly", async (t) => {
  const home = await temporaryHome(t);
  await append(home, line(record({ requestId: "discovery", estimatedCostUsd: 1.2, estimatedUncachedCostUsd: 2.4 })));
  await append(home, line(record({ requestId: "final", includedInCoreUsage: true,
    estimatedCostUsd: 9, estimatedUncachedCostUsd: 12 })));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 1.2, extraUncachedUsd: 2.4, partial: false, requests: 1, pricedRequests: 1,
  });
});

test("malformed and oversized lines mark summaries partial without blocking later rows", async (t) => {
  const home = await temporaryHome(t);
  await append(home, "{bad json}\n");
  await append(home, `${"x".repeat(64 * 1024 + 1)}\n`);
  await append(home, line(record({ requestId: "after_corruption" })));
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 0.25, extraUncachedUsd: 0.5, partial: true, requests: 1, pricedRequests: 1,
  });
});

test("unattributed and corrupt metadata never produce nonfinite totals", async (t) => {
  const home = await temporaryHome(t);
  await append(home, line(record({ requestId: "unattributed", threadId: null, estimatedCostUsd: 3 })));
  await append(home, line(record({ requestId: "huge", estimatedCostUsd: 1e308, estimatedUncachedCostUsd: 1e308 })));
  await append(home, line(record({ requestId: "overflow", estimatedCostUsd: 1e308, estimatedUncachedCostUsd: 1e308 })));
  const result = await readUnreportedProviderUsage(threadId, { home });
  assert.equal(result.requests, 2);
  assert.equal(result.pricedRequests, 1);
  assert.equal(result.partial, true);
  assert.ok(Number.isFinite(result.extraCostUsd));
  assert.ok(Number.isFinite(result.extraUncachedUsd));
});

const sessionZero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
  requests: 0, knownUsageRequests: 0, partial: false };

test("session usage missing ledger and empty ledger report numeric zero", async t => {
  const home = await temporaryHome(t);
  assert.deepEqual(await readProviderSessionUsage(threadId, { home }), sessionZero);
  await fs.writeFile(path.join(home, "provider-usage.jsonl"), "");
  assert.deepEqual(await readProviderSessionUsage(threadId, { home }), sessionZero);
});

test("session usage includes unpriced discovery and failed attempts but excludes core replies", async t => {
  const home = await temporaryHome(t);
  await append(home, line(record({ requestId: "discovery", estimatedCostUsd: null, estimatedUncachedCostUsd: null })));
  await append(home, line(record({ requestId: "failed", status: "output_limit", attempt: 2 })));
  await append(home, line(record({ requestId: "final", includedInCoreUsage: true, estimatedCostUsd: null })));
  assert.deepEqual(await readProviderSessionUsage(threadId, { home }), {
    inputTokens: 200, outputTokens: 60, cachedInputTokens: 40, totalTokens: 260,
    requests: 2, knownUsageRequests: 2, partial: false });
  assert.deepEqual(await readUnreportedProviderUsage(threadId, { home }), {
    extraCostUsd: 0.25, extraUncachedUsd: 0.5, partial: true, requests: 2, pricedRequests: 1 });
});

test("session usage keeps unknown attribution and missing usage partial without guessing totals", async t => {
  const home = await temporaryHome(t);
  await append(home, line(record({ requestId: "unknown_usage", usageKnown: false, usage: null })));
  await append(home, line(record({ requestId: "unknown_inclusion", includedInCoreUsage: null })));
  await append(home, line(record({ requestId: "bad_usage", usage: { ...usage, total_tokens: 1 } })));
  await append(home, line(record({ requestId: "known" })));
  assert.deepEqual(await readProviderSessionUsage(threadId, { home }), {
    inputTokens: 100, outputTokens: 30, cachedInputTokens: 20, totalTokens: 130,
    requests: 3, knownUsageRequests: 1, partial: true });
});

test("session and cost reads share request deduplication and preserve thread attribution", async t => {
  const home = await temporaryHome(t);
  const a = record({ requestId: "one" });
  await append(home, line(a) + line(a) + line(record({ requestId: "one", attempt: 2 }))
    + line(record({ requestId: "other", threadId: otherThreadId })));
  const values = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2
    ? readUnreportedProviderUsage(threadId, { home }) : readProviderSessionUsage(threadId, { home })));
  for (let i = 0; i < values.length; i += 2) assert.equal(values[i].totalTokens, 260);
  assert.equal((await readProviderSessionUsage(otherThreadId, { home })).totalTokens, 130);
  assert.equal((await readUnreportedProviderUsage(threadId, { home })).requests, 2);
});

test("session usage waits for partial records then resets on replacement", async t => {
  const home = await temporaryHome(t);
  const file = path.join(home, "provider-usage.jsonl");
  const text = line(record());
  await fs.writeFile(file, text.slice(0, 30));
  assert.deepEqual(await readProviderSessionUsage(threadId, { home }), sessionZero);
  await fs.appendFile(file, text.slice(30));
  assert.equal((await readProviderSessionUsage(threadId, { home })).totalTokens, 130);
  await fs.rename(file, `${file}.old`);
  await fs.writeFile(file, line(record({ requestId: "replacement", includedInCoreUsage: true })));
  assert.deepEqual(await readProviderSessionUsage(threadId, { home }), sessionZero);
});

test("session usage rejects unsafe cumulative totals without corrupting known aggregates", async t => {
  const home = await temporaryHome(t);
  const hugeUsage = { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: Number.MAX_SAFE_INTEGER };
  await append(home, line(record({ requestId: "huge", usage: hugeUsage })));
  await append(home, line(record({ requestId: "overflow", usage: hugeUsage })));
  const summary = await readProviderSessionUsage(threadId, { home });
  assert.equal(summary.totalTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.knownUsageRequests, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.partial, true);
});

test("session usage malformed lines mark partial without losing valid numeric usage", async t => {
  const home = await temporaryHome(t);
  await append(home, "bad json\n" + line(record()));
  const summary = await readProviderSessionUsage(threadId, { home });
  assert.equal(summary.totalTokens, 130);
  assert.equal(summary.partial, true);
});
