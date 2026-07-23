import fs from "node:fs/promises";
import { telemetryPath } from "./paths.mjs";

export async function readTelemetry(file = telemetryPath()) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.schema === "codex-zero-telemetry-v1") records.push(record);
    } catch {
      throw new Error(`Invalid telemetry JSON at line ${index + 1}`);
    }
  }
  return records;
}

export function aggregateSavings(records) {
  const result = {
    schema: "codex-zero-savings-v1",
    measured: {
      transformedPayloads: 0,
      rejectedPayloads: 0,
      exactDuplicateResults: 0,
      modelVisibleTokensBefore: 0,
      modelVisibleTokensAfter: 0,
      modelVisibleTokensEliminated: 0,
      modelCallsEliminated: 0
    },
    cacheEffects: {
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      note: "Reported separately; cache reuse is not counted as guaranteed savings."
    },
    observedUsage: {
      turns: 0,
      inputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      toolCalls: 0
    },
    firstEventMs: null,
    lastEventMs: null
  };

  for (const record of records) {
    if (Number.isFinite(record.timestamp_ms)) {
      result.firstEventMs = result.firstEventMs === null
        ? record.timestamp_ms
        : Math.min(result.firstEventMs, record.timestamp_ms);
      result.lastEventMs = result.lastEventMs === null
        ? record.timestamp_ms
        : Math.max(result.lastEventMs, record.timestamp_ms);
    }
    if (record.event === "exec_model_payload" || record.event === "exact_duplicate_result") {
      result.measured.modelVisibleTokensBefore += finiteNonNegative(record.original_tokens);
      result.measured.modelVisibleTokensAfter += finiteNonNegative(record.selected_tokens);
      result.measured.modelVisibleTokensEliminated += finiteNonNegative(record.tokens_eliminated);
      if (record.transformed) result.measured.transformedPayloads += 1;
      else result.measured.rejectedPayloads += 1;
      if (record.event === "exact_duplicate_result" && record.transformed) {
        result.measured.exactDuplicateResults += 1;
      }
    } else if (record.event === "model_call_eliminated") {
      result.measured.modelCallsEliminated += finiteNonNegative(record.count);
    } else if (record.event === "usage") {
      result.cacheEffects.cachedInputTokens += finiteNonNegative(record.cached_input_tokens);
      result.cacheEffects.cacheWriteTokens += finiteNonNegative(record.cache_write_tokens);
      result.observedUsage.turns += 1;
      result.observedUsage.inputTokens += finiteNonNegative(record.input_tokens);
      result.observedUsage.uncachedInputTokens += finiteNonNegative(record.uncached_input_tokens);
      result.observedUsage.outputTokens += finiteNonNegative(record.output_tokens);
      result.observedUsage.reasoningTokens += finiteNonNegative(record.reasoning_tokens);
      result.observedUsage.toolCalls += finiteNonNegative(record.tool_calls);
    }
  }
  return result;
}

export function formatSavings(summary) {
  const m = summary.measured;
  const reduction = m.modelVisibleTokensBefore === 0
    ? 0
    : (m.modelVisibleTokensEliminated / m.modelVisibleTokensBefore) * 100;
  const range = summary.firstEventMs === null
    ? "No measured CodexZero events yet."
    : `${new Date(summary.firstEventMs).toLocaleString()} → ${new Date(summary.lastEventMs).toLocaleString()}`;
  return [
    "CodexZero savings",
    range,
    "",
    `Model-visible tokens eliminated: ${number(m.modelVisibleTokensEliminated)}`,
    `Payload tokens: ${number(m.modelVisibleTokensBefore)} → ${number(m.modelVisibleTokensAfter)} (${reduction.toFixed(1)}% lower)`,
    `Payloads transformed: ${number(m.transformedPayloads)}`,
    `Exact duplicate results referenced: ${number(m.exactDuplicateResults)}`,
    `Candidates rejected by the monotonic gate: ${number(m.rejectedPayloads)}`,
    `Model calls eliminated: ${number(m.modelCallsEliminated)}`,
    "",
    `Cached input tokens observed: ${number(summary.cacheEffects.cachedInputTokens)}`,
    `Cache-write tokens observed: ${number(summary.cacheEffects.cacheWriteTokens)}`,
    `Measured turns: ${number(summary.observedUsage.turns)}`,
    `Measured tool calls: ${number(summary.observedUsage.toolCalls)}`,
    "Cache effects are shown separately and are not counted as guaranteed savings.",
    "",
    "Only measured events are included. Future projections are not mixed into this total."
  ].join("\n");
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function number(value) {
  return new Intl.NumberFormat().format(value);
}
