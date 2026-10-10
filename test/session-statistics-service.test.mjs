import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCacheSnapshot } from "../src/cache-service.mjs";

test("session stats reach the desktop snapshot with measured timing and weighted cache hits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-session-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "codexzero"), sessions = path.join(root, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const id = `stats_${path.basename(root)}`, epoch = Date.parse("2026-10-10T12:00:00Z");
  const rec = (offset, type, payload) => ({ timestamp: new Date(epoch + offset).toISOString(), type, payload });
  const tokens = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 };
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  const records = [rec(0, "session_meta", { id }), rec(0, "event_msg", { type: "turn_started", turn_id: "turn1" }),
    rec(0, "turn_context", { turn_id: "turn1", model: "gpt-6.1-sol" }),
    rec(3000, "event_msg", { type: "token_count", info: { total_token_usage: tokens, last_token_usage: tokens } }),
    rec(5000, "event_msg", { type: "turn_complete", turn_id: "turn1", duration_ms: 5000, time_to_first_token_ms: 1000,
      turn_profile: { sampling_ms: 2000, sampling_request_count: 1, tool_blocking_ms: 3000 } })];
  await fs.writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const first = await readCacheSnapshot(id, home);
  assert.equal(first.sessionStats.turns, 1);
  assert.equal(first.sessionStats.modelSteps, 1);
  assert.equal(first.sessionStats.llmTimeMs, 2000);
  assert.equal(first.sessionStats.toolTimeMs, 3000);
  assert.equal(first.sessionStats.avgTtftMs, 1000);
  assert.equal(first.sessionStats.tokensPerSecond, 50);
  assert.equal(first.sessionStats.totalTokens, 1100);
  assert.equal(first.sessionStats.cacheHitRate, .8);
  assert.deepEqual((await readCacheSnapshot(id, home)).sessionStats, first.sessionStats, "Polling does not duplicate stats");
  assert.equal(JSON.stringify(first).includes("turn1"), false, "Desktop receives aggregates, not request identifiers");
});
