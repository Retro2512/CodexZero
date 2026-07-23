import assert from "node:assert/strict";
import test from "node:test";
import { aggregateSavings } from "../src/savings.mjs";

test("aggregates only measured transformations and separates cache effects", () => {
  const result = aggregateSavings([
    {
      schema: "codex-zero-telemetry-v1",
      event: "exec_model_payload",
      timestamp_ms: 10,
      original_tokens: 100,
      selected_tokens: 40,
      tokens_eliminated: 60,
      transformed: true
    },
    {
      schema: "codex-zero-telemetry-v1",
      event: "exec_model_payload",
      timestamp_ms: 20,
      original_tokens: 8,
      selected_tokens: 8,
      tokens_eliminated: 0,
      transformed: false
    },
    {
      schema: "codex-zero-telemetry-v1",
      event: "usage",
      input_tokens: 900,
      cached_input_tokens: 500,
      cache_write_tokens: 20,
      uncached_input_tokens: 400,
      output_tokens: 30,
      reasoning_tokens: 10,
      tool_calls: 3
    },
    {
      schema: "codex-zero-telemetry-v1",
      event: "exact_duplicate_result",
      original_tokens: 80,
      selected_tokens: 20,
      tokens_eliminated: 60,
      transformed: true
    }
  ]);

  assert.equal(result.measured.modelVisibleTokensEliminated, 120);
  assert.equal(result.measured.transformedPayloads, 2);
  assert.equal(result.measured.rejectedPayloads, 1);
  assert.equal(result.measured.exactDuplicateResults, 1);
  assert.equal(result.cacheEffects.cachedInputTokens, 500);
  assert.equal(result.observedUsage.turns, 1);
  assert.equal(result.observedUsage.toolCalls, 3);
});
