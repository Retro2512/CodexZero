import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CacheRolloutReader, ConversationAccounting } from "../src/cache-accounting.mjs";
import { SessionStatisticsAccumulator, combineSessionStats } from "../src/session-statistics.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const record = (ms, type, payload) => ({ timestamp: new Date(NOW + ms).toISOString(), type, payload });
const event = (ms, type, payload = {}) => record(ms, "event_msg", { type, ...payload });
const start = (id, ms = 0, type = "task_started") => event(ms, type, { turn_id: id });
const end = (id, ms, payload = {}, type = "task_complete") => event(ms, type, { turn_id: id, ...payload });
const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached,
  output_tokens: output, reasoning_output_tokens: output, total_tokens: input + output });
const tokens = (ms, total, last = total) => event(ms, "token_count", { info: {
  total_token_usage: total, last_token_usage: last } });
const response = (ms, id, turnId, total, last = total) => record(ms, "token_usage_record", {
  response_id: id, turn_id: turnId, thread_token_usage: total, usage: last });
const call = (ms, id, type = "function_call") => record(ms, "response_item", { type, call_id: id, arguments: "private" });
const output = (ms, id, type = "function_call_output") => record(ms, "response_item", { type, call_id: id, output: "private" });
const tool = (ms, turnId, id, startMs, endMs) => event(ms, "item_completed", {
  turn_id: turnId, item: { type: "CommandExecution", id, command: "private" },
  started_at_ms: NOW + startMs, completed_at_ms: NOW + endMs });
const profile = (sampling_ms, tool_blocking_ms, sampling_request_count) => ({
  turn_profile: { sampling_ms, tool_blocking_ms, sampling_request_count } });
const accept = (...records) => { const stats = new SessionStatisticsAccumulator(); records.forEach(r => stats.accept(r)); return stats; };
const lines = records => records.map(r => `${JSON.stringify(r)}\n`).join("");

test("empty session reports no invented latency or throughput", () => {
  assert.deepEqual(new SessionStatisticsAccumulator().snapshot, {
    turns: 0, modelSteps: 0, llmTimeMs: null, toolTimeMs: 0, avgTtftMs: null, tokensPerSecond: null,
    totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheHitRate: null,
    llmTimeSamples: 0, llmOutputTokens: 0, ttftTotalMs: 0, ttftSamples: 0, partial: false });
});

test("task lifecycle deduplicates turns and exact profiles populate model time", () => {
  const stats = accept(start("a"), start("a"),
    record(1, "turn_context", { turn_id: "a", model: "gpt-6-sol" }),
    tokens(200, usage(100, 40, 20)), end("a", 500, { ...profile(400, 50, 2), time_to_first_token_ms: 100 }),
    end("a", 500, { ...profile(400, 50, 2), time_to_first_token_ms: 100 }));
  const s = stats.snapshot;
  assert.equal(s.turns, 1);
  assert.equal(s.modelSteps, 2);
  assert.equal(s.llmTimeMs, 400);
  assert.equal(s.toolTimeMs, 50);
  assert.equal(s.avgTtftMs, 100);
  assert.equal(s.tokensPerSecond, 50);
  assert.equal(s.totalTokens, 120);
  assert.equal(s.cacheHitRate, 0.4);
  assert.equal(s.partial, false);
});

test("latest upstream turn lifecycle spellings share task compatibility", () => {
  const stats = accept(start("a", 0, "turn_started"), tokens(20, usage(10, 0, 2)),
    end("a", 100, { ...profile(80, 0, 1), time_to_first_token_ms: 12 }, "turn_complete"));
  assert.equal(stats.snapshot.llmTimeMs, 80);
  assert.equal(stats.snapshot.avgTtftMs, 12);
  assert.equal(stats.snapshot.turns, 1);
});

test("legacy timestamps never masquerade as model time or TTFT", () => {
  const stats = accept(start("a"), tokens(200, usage(10, 0, 2)), call(220, "c"), output(400, "c"), end("a", 800));
  assert.equal(stats.snapshot.llmTimeMs, null);
  assert.equal(stats.snapshot.avgTtftMs, null);
  assert.equal(stats.snapshot.tokensPerSecond, null);
  assert.equal(stats.snapshot.toolTimeMs, 180);
  assert.equal(stats.snapshot.partial, true);
});

test("duplicate token_count updates and mirrored response usage count each step once", () => {
  const first = usage(100, 40, 20), second = usage(150, 60, 30), last = usage(50, 20, 10);
  const stats = accept(start("a"), response(50, "r1", "a", first), tokens(51, first), tokens(52, first),
    response(100, "r2", "a", second, last), tokens(101, second, last),
    response(102, "r2", "a", second, last), end("a", 200, profile(100, 0, 2)));
  assert.equal(stats.snapshot.modelSteps, 2);
  assert.equal(stats.snapshot.inputTokens, 150);
  assert.equal(stats.snapshot.outputTokens, 30);
  assert.equal(stats.snapshot.totalTokens, 180);
});

test("a mirrored response that follows legacy token usage does not double count", () => {
  const first = usage(10, 2, 3);
  const stats = accept(start("a"), tokens(50, first), response(51, "r1", "a", first));
  assert.equal(stats.snapshot.modelSteps, 1);
  assert.equal(stats.snapshot.totalTokens, 13);
});

test("copied history preserves usage, turn and timing deduplication", () => {
  const history = [start("a"), response(50, "r1", "a", usage(100, 40, 20)),
    tokens(51, usage(100, 40, 20)), call(60, "c"), output(80, "c"),
    end("a", 100, { ...profile(50, 20, 1), time_to_first_token_ms: 4 })];
  const stats = accept(...history);
  const original = { ...stats.snapshot };
  history.forEach(r => stats.accept(r));
  assert.deepEqual(stats.snapshot, original);
  stats.accept(start("b", 200));
  stats.accept(response(250, "r2", "b", usage(110, 40, 23), usage(10, 0, 3)));
  stats.accept(end("b", 300, profile(50, 0, 1)));
  assert.equal(stats.snapshot.totalTokens, 133);
  assert.equal(stats.snapshot.turns, 2);
});

test("compaction baseline resets do not bill synthetic usage or lose future steps", () => {
  const stats = accept(start("a"), tokens(10, usage(100, 40, 20)),
    tokens(20, usage(0, 0, 0), usage(0, 0, 0)),
    tokens(30, usage(10, 5, 2)), end("a", 100));
  assert.equal(stats.snapshot.totalTokens, 132);
  assert.equal(stats.snapshot.modelSteps, 2);
  assert.equal(stats.snapshot.partial, true);
});

test("unique raw response IDs remain countable after upstream totals reset", () => {
  const stats = accept(start("a"), response(10, "r1", "a", usage(100, 40, 20)),
    response(20, "r2", "a", usage(10, 5, 2)), tokens(21, usage(10, 5, 2)));
  assert.equal(stats.snapshot.totalTokens, 132);
  assert.equal(stats.snapshot.modelSteps, 2);
});

test("parallel and nested tools use a union rather than sum", () => {
  const stats = accept(start("a"), call(20, "outer", "custom_tool_call"),
    call(30, "inner"), tool(80, "a", "command", 35, 70), output(100, "inner"),
    output(120, "outer", "custom_tool_call_output"), output(150, "outer", "custom_tool_call_output"));
  assert.equal(stats.snapshot.toolTimeMs, 100);
});

test("unrelated overlapping turns retain their own tool intervals", () => {
  const stats = accept(start("a"), tool(150, "a", "one", 20, 100), start("b", 30), tool(150, "b", "two", 40, 120));
  assert.equal(stats.snapshot.turns, 2);
  assert.equal(stats.snapshot.toolTimeMs, 160);
});

test("missing call starts and missing legacy item timing mark partial tool accounting", () => {
  const stats = accept(start("a"), output(100, "missing"), event(200, "item_completed", {
    turn_id: "a", item: { type: "CommandExecution", id: "legacy" }, completed_at_ms: NOW + 200 }));
  assert.equal(stats.snapshot.toolTimeMs, 0);
  assert.equal(stats.snapshot.partial, true);
});

test("bad and negative timings never generate NaN or fabricated throughput", () => {
  const stats = accept(start("a"), tokens(10, usage(100, 101, 1)),
    end("a", 20, { ...profile(-1, NaN, 1.5), time_to_first_token_ms: -1 }));
  assert.equal(stats.snapshot.totalTokens, 0);
  assert.equal(stats.snapshot.llmTimeMs, null);
  assert.equal(stats.snapshot.avgTtftMs, null);
  assert.equal(stats.snapshot.partial, true);
});

test("combining uses weighted latency, timing output and token cache ratios", () => {
  const a = accept(start("a"), tokens(10, usage(100, 50, 10)), end("a", 100, { ...profile(100, 0, 1), time_to_first_token_ms: 20 }));
  const b = accept(start("b"), tokens(10, usage(900, 0, 40)), end("b", 100, { ...profile(400, 20, 1), time_to_first_token_ms: 80 }),
    start("c", 200), tokens(210, usage(1000, 0, 50), usage(100, 0, 10)), end("c", 300, { ...profile(100, 0, 1), time_to_first_token_ms: 50 }));
  const combined = combineSessionStats([{ sessionStats: a.snapshot }, b.snapshot]);
  assert.equal(combined.avgTtftMs, 50);
  assert.equal(combined.tokensPerSecond, 100);
  assert.equal(combined.cacheHitRate, 50 / 1100);
  assert.equal(combined.llmTimeMs, 600);
  assert.equal(combined.turns, 3);
});

test("unknown older turn output does not contaminate sampled tokens per second", () => {
  const stats = accept(start("a"), tokens(10, usage(100, 0, 100)), end("a", 100),
    start("b", 200), tokens(210, usage(200, 0, 110), usage(100, 0, 10)), end("b", 300, profile(100, 0, 1)));
  assert.equal(stats.snapshot.tokensPerSecond, 100);
  assert.equal(stats.snapshot.llmOutputTokens, 10);
  assert.equal(stats.snapshot.outputTokens, 110);
});

test("conversation snapshot serializes aggregates and never retains message bodies", () => {
  const accounting = new ConversationAccounting("a");
  [start("a"), record(1, "response_item", { type: "message", role: "assistant", content: [{ text: "secret content" }] }),
    call(20, "c"), output(30, "c"), tokens(50, usage(10, 1, 2)), end("a", 100, profile(60, 10, 1))].forEach(r => accounting.accept(r));
  const serialized = JSON.stringify(accounting.snapshot);
  assert.equal(JSON.parse(serialized).sessionStats.totalTokens, 12);
  assert.equal(serialized.includes("secret content"), false);
  assert.equal(serialized.includes("private"), false);
});

test("latest turn_complete spelling updates cache user activity without refreshing keep warm activity", () => {
  const accounting = new ConversationAccounting("a");
  accounting.accept(event(0, "user_message", { message: "work" }));
  accounting.accept(end("a", 100, profile(60, 10, 1), "turn_complete"));
  assert.equal(accounting.snapshot.lastUserAt, NOW + 100);
  accounting.accept(event(200, "user_message", { message: 'Ignore this message - Reply Only "OK"' }));
  accounting.accept(end("b", 300, profile(60, 10, 1), "turn_complete"));
  assert.equal(accounting.snapshot.lastUserAt, NOW + 100);
});

test("rollout reader recovers incremental history, partial records, rotation and truncation", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-session-stats-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  const first = [start("a"), tokens(10, usage(10, 2, 3)), end("a", 100, profile(50, 10, 1))];
  const second = [start("b", 200), tokens(210, usage(20, 4, 6), usage(10, 2, 3)), end("b", 300, profile(50, 0, 1))];
  const text = lines(second);
  await fs.writeFile(file, lines(first) + text.slice(0, 20));
  const reader = new CacheRolloutReader("a", file);
  assert.equal((await reader.read()).sessionStats.turns, 1);
  assert.equal((await reader.read()).sessionStats.totalTokens, 13);
  await fs.appendFile(file, text.slice(20));
  assert.equal((await reader.read()).sessionStats.totalTokens, 26);
  assert.equal((await reader.read()).sessionStats.turns, 2);
  await fs.rename(file, path.join(dir, "old.jsonl"));
  await fs.writeFile(file, lines(first));
  assert.equal((await reader.read()).sessionStats.totalTokens, 13);
  await fs.writeFile(file, lines([start("c")]));
  assert.equal((await reader.read()).sessionStats.totalTokens, 0);
  assert.equal((await reader.read()).sessionStats.turns, 1);
});

test("malformed lines flag partial statistics without discarding valid records", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-session-stats-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  await fs.writeFile(file, lines([start("a")]) + "bad json\n" + lines([tokens(20, usage(10, 0, 2))]));
  const snapshot = await new CacheRolloutReader("a", file).read();
  assert.equal(snapshot.sessionStats.totalTokens, 12);
  assert.equal(snapshot.sessionStats.partial, true);
});
