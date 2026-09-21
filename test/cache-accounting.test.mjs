import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationAccounting,
  KEEP_WARM_MESSAGE,
  MINUTE,
  cacheWindowMs,
  normalizeUsage,
  priceUsage,
  shouldKeepWarm,
  warmth,
} from "../src/cache-accounting.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offset) => new Date(NOW + offset).toISOString();
const usage = (input, read = 0, write = 0, output = 0) => ({
  input_tokens: input,
  cached_input_tokens: read,
  cache_write_input_tokens: write,
  output_tokens: output,
});
const turn = (timestamp, model = "gpt-5.6-sol", service_tier = "default") => ({
  timestamp,
  type: "turn_context",
  payload: { model, service_tier },
});
const tokens = (timestamp, total, last = total) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last },
  },
});
const userMessage = (timestamp, message) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "user_message", message },
});

test("usage normalization accepts both wire spellings and rejects unsafe counts", () => {
  assert.deepEqual(normalizeUsage({
    inputTokens: 10,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 3,
    outputTokens: 4,
  }), { input: 10, read: 2, write: 3, output: 4 });
  assert.deepEqual(normalizeUsage({
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 4,
  }), { input: 10, read: 2, write: 0, output: 4 });
  for (const bad of [null, {}, { input_tokens: -1, cached_input_tokens: 0, output_tokens: 0 },
    { input_tokens: 1.5, cached_input_tokens: 0, output_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: 0, output_tokens: 0 }]) {
    assert.equal(normalizeUsage(bad), null);
  }
});

test("cache writes use their category rate rather than adding a surcharge", () => {
  const priced = priceUsage("gpt-5.6-sol", usage(10, 2, 3, 4));
  assert.deepEqual(priced, { usd: 0.0001158, uncachedUsd: 0.00012 });

  const noWrite = priceUsage("gpt-5.6-sol", usage(10, 2, 0, 4));
  assert.ok(Math.abs((priced.usd - noWrite.usd) - 0.000003) < 1e-15);
});

test("reasoning is not billed a second time and Standard differs from Fast", () => {
  const standard = priceUsage("gpt-6-astra", {
    ...usage(1_000, 200, 100, 50),
    reasoning_tokens: 900,
  }, "default");
  const standardWithoutReasoning = priceUsage("gpt-6-astra", usage(1_000, 200, 100, 50), "default");
  assert.deepEqual(standard, standardWithoutReasoning);

  const fast = priceUsage("gpt-6-astra", usage(1_000, 200, 100, 50), "fast");
  const priority = priceUsage("gpt-6-astra", usage(1_000, 200, 100, 50), "priority");
  assert.deepEqual(fast, priority);
  assert.equal(fast.usd, standard.usd * 2);
  assert.equal(priceUsage("not-a-model", usage(1, 0, 0, 1)), null);
  assert.equal(priceUsage("gpt-6-astra", usage(1, 0, 0, 1), "turbo"), null);
});

test("the 272k boundary applies long context multipliers only where documented", () => {
  const atBoundary = priceUsage("gpt-5.6-sol", usage(272_000, 0, 0, 1));
  const overBoundary = priceUsage("gpt-5.6-sol", usage(272_001, 0, 0, 1));
  assert.equal(atBoundary.usd, (272_000 * 4 + 20) / 1e6);
  assert.equal(overBoundary.usd, (272_001 * 4 * 2 + 20 * 1.5) / 1e6);

  const standardLong = priceUsage("gpt-5.5", usage(272_001, 0, 0, 1), "default");
  assert.equal(standardLong.usd, (272_001 * 5 * 2 + 30 * 1.5) / 1e6);
  assert.equal(priceUsage("gpt-5.5", usage(272_001, 0, 0, 1), "fast"), null);
  assert.equal(priceUsage("gpt-5.5", usage(272_001, 0, 0, 1), "priority"), null);
});

test("cache window and warmth are explicit estimates and expire deterministically", () => {
  assert.equal(cacheWindowMs("gpt-6-astra"), 30 * MINUTE);
  assert.equal(cacheWindowMs("gpt-5.3-codex"), 5 * MINUTE);
  assert.equal(cacheWindowMs("unknown"), null);

  const snapshot = { model: "gpt-6-astra", lastCacheAt: NOW - 27 * MINUTE };
  assert.deepEqual(warmth(snapshot, NOW), { state: "warm", remainingMs: 3 * MINUTE, estimated: true });
  assert.equal(warmth({ ...snapshot, lastCacheAt: NOW - 29 * MINUTE }, NOW).state, "cooling");
  assert.equal(warmth({ ...snapshot, lastCacheAt: NOW - 30 * MINUTE }, NOW).state, "cold");
  assert.equal(warmth({ ...snapshot, invalidated: true }, NOW).state, "unknown");
  assert.equal(warmth({ ...snapshot, lastCacheAt: 0 }, NOW).state, "unknown");
});

test("keep warm requires eligibility, recent activity, and an expiring observed cache", () => {
  const snapshot = {
    id: "thread_1",
    model: "gpt-6-astra",
    lastCacheAt: NOW - 29 * MINUTE,
    lastUserAt: NOW - 5 * MINUTE,
    active: false,
    blocked: false,
    error: null,
  };
  const settings = { enabled: true, minutes: 30, overrides: {}, activity: {} };
  assert.equal(shouldKeepWarm(snapshot, settings, NOW), true);
  assert.equal(shouldKeepWarm(snapshot, { ...settings, enabled: false }, NOW), false);
  assert.equal(shouldKeepWarm(snapshot, { ...settings, overrides: { thread_1: false } }, NOW), false);
  assert.equal(shouldKeepWarm(snapshot, { ...settings, overrides: { thread_1: true } }, NOW), true);

  assert.equal(shouldKeepWarm({ ...snapshot, active: true }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, blocked: true }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, error: "Refresh paused" }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, lastCacheAt: NOW - 30 * MINUTE }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, lastUserAt: NOW - 30 * 1_000 }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, lastUserAt: NOW - 31 * MINUTE }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, lastAttemptAt: NOW - 30_000 }, settings, NOW), false);
  assert.equal(shouldKeepWarm({ ...snapshot, lastAttemptAt: NOW - 2 * MINUTE }, settings, NOW), true);

  const settingsActivity = { ...settings, activity: { thread_1: NOW - 2 * MINUTE } };
  assert.equal(shouldKeepWarm({ ...snapshot, lastUserAt: null }, settingsActivity, NOW), true);
  assert.equal(shouldKeepWarm({ ...snapshot, lastUserAt: null }, { ...settings, activity: { thread_1: NOW } }, NOW), false);
  assert.equal(shouldKeepWarm(snapshot, { ...settings, minutes: 4 }, NOW), false);
});

test("conversation accounting prices each monotonic request once and does not mistake cache misses for warmth", () => {
  const accounting = new ConversationAccounting("thread_1");
  accounting.accept(turn(at(-10 * MINUTE), "gpt-5.6-sol"));
  const first = usage(100, 20, 0, 10);
  accounting.accept(tokens(at(-9 * MINUTE), first));
  const once = { ...accounting.snapshot.cost };
  accounting.accept(tokens(at(-8 * MINUTE), first));
  assert.equal(accounting.snapshot.requests, 1);
  assert.deepEqual(accounting.snapshot.cost, once);
  assert.equal(accounting.snapshot.lastCacheAt, at(-9 * MINUTE) ? Date.parse(at(-9 * MINUTE)) : null);
  assert.equal(accounting.snapshot.invalidated, false);

  const second = usage(140, 20, 0, 15);
  accounting.accept(tokens(at(-7 * MINUTE), second, usage(40, 0, 0, 5)));
  assert.equal(accounting.snapshot.requests, 2);

  // A cache miss is still billable, but it invalidates the prior warmth claim.
  const miss = usage(150, 20, 0, 16);
  accounting.accept(tokens(at(-6 * MINUTE), miss, usage(10, 0, 0, 1)));
  assert.equal(accounting.snapshot.requests, 3);
  assert.equal(accounting.snapshot.invalidated, true);
  assert.equal(warmth(accounting.snapshot, NOW).state, "unknown");
});

test("compaction and model switches invalidate lineage without billing reset totals twice", () => {
  const accounting = new ConversationAccounting("thread_2");
  accounting.accept(turn(at(-10 * MINUTE), "gpt-5.6-sol"));
  accounting.accept(tokens(at(-9 * MINUTE), usage(100, 10, 0, 10)));
  const firstCost = accounting.snapshot.cost.usd;

  accounting.accept({ timestamp: at(-8 * MINUTE), type: "compacted", payload: {} });
  assert.equal(accounting.snapshot.invalidated, true);
  accounting.accept(tokens(at(-7 * MINUTE), usage(50, 10, 0, 5), usage(50, 0, 0, 5)));
  assert.equal(accounting.snapshot.requests, 1);
  assert.equal(accounting.snapshot.cost.usd, firstCost);

  accounting.accept(turn(at(-6 * MINUTE), "gpt-5.5"));
  assert.equal(accounting.snapshot.invalidated, true);
  accounting.accept(tokens(at(-5 * MINUTE), usage(70, 20, 0, 8), usage(20, 10, 0, 3)));
  assert.equal(accounting.snapshot.requests, 2);
  assert.equal(accounting.snapshot.model, "gpt-5.5");
  assert.equal(accounting.snapshot.invalidated, false);
});

test("ordinary activity is recorded while the keep warm message and its completion do not renew it", () => {
  const accounting = new ConversationAccounting("thread_3");
  accounting.accept(userMessage(at(-5 * MINUTE), "real work"));
  assert.equal(accounting.snapshot.lastUserAt, NOW - 5 * MINUTE);
  accounting.accept(userMessage(at(-2 * MINUTE), KEEP_WARM_MESSAGE));
  assert.equal(accounting.snapshot.lastUserAt, NOW - 5 * MINUTE);
  accounting.accept({ timestamp: at(-1 * MINUTE), type: "event_msg", payload: { type: "task_completed" } });
  assert.equal(accounting.snapshot.lastUserAt, NOW - 5 * MINUTE);
  accounting.accept(userMessage(at(0), "more work"));
  assert.equal(accounting.snapshot.lastUserAt, NOW);
});
