import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import {
  KEEP_WARM_MESSAGE,
  MINUTE,
  priceUsage,
} from "../src/cache-accounting.mjs";
import {
  CacheMonitor,
  CacheRolloutReader,
} from "../src/cache-monitor.mjs";
import {
  cacheDirectory,
  cacheActivity,
  readCacheSettings,
  readCacheSnapshot,
  saveCacheSettings,
  setCacheEnabled,
  validateThreadId,
} from "../src/cache-service.mjs";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const at = (offset) => new Date(NOW + offset).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const usage = (input, read = 0, write = 0, output = 0) => ({
  input_tokens: input,
  cached_input_tokens: read,
  cache_write_input_tokens: write,
  output_tokens: output,
});
const turn = (timestamp, model = "gpt-6-astra") => ({
  timestamp, type: "turn_context", payload: { model },
});
const tokens = (timestamp, total, last = total) => ({
  timestamp, type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: total, last_token_usage: last } },
});
const rolloutRecords = ({ user = "real work", cacheAt = -29 * MINUTE, model = "gpt-6-astra", turnId } = {}) => {
  const first = usage(100, 20, 0, 10);
  return [
    { timestamp: at(-30 * MINUTE), type: "turn_context", payload: { model, service_tier: "default", ...(turnId ? { turn_id: turnId } : {}) } },
    { timestamp: at(-5 * MINUTE), type: "event_msg", payload: { type: "user_message", message: user } },
    { timestamp: at(cacheAt), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: first, last_token_usage: first } } },
  ];
};

async function temporary(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-cache-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function flush() {
  await immediate();
  await immediate();
}

async function waitForFile(file, present) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const exists = await fs.access(file).then(() => true, () => false);
    if (exists === present) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${file} to be ${present ? "present" : "absent"}`);
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForJson(file, predicate, label = file) {
  let value;
  await waitUntil(async () => {
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"));
      return predicate(value);
    } catch {
      return false;
    }
  }, label);
  return value;
}

async function quietRemember(monitor, result) {
  // remember schedules an observation immediately. Hold that observation while
  // the fixture is installed, then turn the monitor back on for the tick under test.
  monitor.closed = true;
  monitor.remember(result);
  monitor.closed = false;
  await flush();
}

function rpcRecorder(id, model = "gpt-6-astra") {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, model, status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: `${id}-refresh` } };
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected RPC ${method}`);
  };
  return { calls, rpc };
}

async function makeRollout(t, records = rolloutRecords()) {
  const home = await temporary(t);
  const file = path.join(home, "rollout.jsonl");
  await fs.writeFile(file, records.map(line).join(""));
  return { home, file };
}

test("cache settings validate values and thread paths cannot escape the cache directory", async (t) => {
  const home = await temporary(t);
  assert.deepEqual(await readCacheSettings(home), { enabled: false, minutes: 30, overrides: {}, activity: {} });
  assert.deepEqual(await saveCacheSettings({ enabled: true, minutes: 7 }, home), { enabled: true, minutes: 7 });
  assert.deepEqual(await readCacheSettings(home), { enabled: true, minutes: 7, overrides: {}, activity: {} });

  for (const invalid of [
    { enabled: true, minutes: 0 },
    { enabled: true, minutes: 1.5 },
    { enabled: true, minutes: 1_441 },
    { enabled: "yes", minutes: 5 },
    { enabled: true, minutes: 5, overrides: {} },
    { enabled: true, minutes: 5, activity: {} },
  ]) await assert.rejects(saveCacheSettings(invalid, home), TypeError);

  for (const unsafe of ["../outside", "..", ".", "a/b", "a\\b", "", "x/../y", `${"x".repeat(129)}`]) {
    assert.throws(() => validateThreadId(unsafe), TypeError);
    await assert.rejects(setCacheEnabled(unsafe, true, home), TypeError);
    await assert.rejects(cacheActivity(unsafe, home), TypeError);
    await assert.rejects(readCacheSnapshot(unsafe, home), TypeError);
  }
  assert.equal(await fs.access(cacheDirectory(home)).then(() => true, () => false), true);
});

test("invalid settings fall back safely instead of making cache status unavailable", async (t) => {
  const home = await temporary(t);
  await fs.mkdir(cacheDirectory(home), { recursive: true });
  await fs.writeFile(path.join(cacheDirectory(home), "settings.json"), "{unfinished");
  assert.deepEqual(await readCacheSettings(home), { enabled: false, minutes: 30, overrides: {}, activity: {} });
  const snapshot = await readCacheSnapshot(null, home);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.warmth.state, "unknown");
});

test("snapshot reads discover and incrementally aggregate every rollout segment for a task", async (t) => {
  const root = await temporary(t);
  const home = path.join(root, "codexzero");
  const sessions = path.join(root, "sessions", "2026", "01", "01");
  const id = "discovered_thread";
  const liveAt = offset => new Date(Date.now() + offset).toISOString();
  await fs.mkdir(sessions, { recursive: true });
  const meta = (timestamp, value = id) => ({ timestamp, type: "session_meta", payload: { id: value } });
  const first = path.join(sessions, `rollout-one-${id}.jsonl`);
  const second = path.join(sessions, `rollout-two-${id}.jsonl`);
  const collision = path.join(sessions, `rollout-collision-${id}.jsonl`);
  await fs.writeFile(first, [meta(liveAt(-40 * MINUTE)), turn(liveAt(-40 * MINUTE)),
    tokens(liveAt(-39 * MINUTE), usage(100, 20, 0, 10))].map(line).join(""));
  await fs.writeFile(second, [meta(liveAt(-35 * MINUTE)), turn(liveAt(-35 * MINUTE)),
    tokens(liveAt(-31 * MINUTE), usage(50, 10, 0, 5))].map(line).join(""));
  await fs.writeFile(collision, [meta(liveAt(-5 * MINUTE), "another_thread"), turn(liveAt(-5 * MINUTE)),
    tokens(liveAt(-4 * MINUTE), usage(1_000, 0, 0, 100))].map(line).join(""));
  await fs.mkdir(cacheDirectory(home), { recursive: true });
  await fs.writeFile(path.join(cacheDirectory(home), `${id}.json`), "{broken");

  let result = await readCacheSnapshot(id, home);
  assert.equal(result.cost.usd, priceUsage("gpt-6-astra", usage(100, 20, 0, 10)).usd +
    priceUsage("gpt-6-astra", usage(50, 10, 0, 5)).usd);
  assert.equal(result.warmth.state, "cold");

  await fs.appendFile(second, line(tokens(liveAt(-1 * MINUTE), usage(80, 20, 0, 8), usage(30, 10, 0, 3))));
  result = await readCacheSnapshot(id, home);
  assert.equal(result.warmth.state, "warm");
  assert.equal(result.cost.usd, priceUsage("gpt-6-astra", usage(100, 20, 0, 10)).usd +
    priceUsage("gpt-6-astra", usage(50, 10, 0, 5)).usd +
    priceUsage("gpt-6-astra", usage(30, 10, 0, 3)).usd);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => readCacheSnapshot(id, home)));
  assert.ok(concurrent.every(value => value.cost.usd === result.cost.usd));
});

test("fresh first request gets a timer even with an old persisted cache miss", async (t) => {
  const root = await temporary(t);
  const home = path.join(root, "codexzero");
  const sessions = path.join(root, "sessions");
  const id = "fresh_miss";
  const live = Date.now();
  const timestamp = new Date(live).toISOString();
  await fs.mkdir(sessions, { recursive: true });
  const amount = usage(23_500, 0, 0, 20);
  await fs.writeFile(path.join(sessions, `rollout-${id}.jsonl`), [
    { timestamp, type: "session_meta", payload: { id } },
    turn(timestamp, "gpt-5.6-sol"), tokens(timestamp, amount),
  ].map(line).join(""));
  await fs.mkdir(cacheDirectory(home), { recursive: true });
  const persisted = { id, model: "gpt-5.6-sol", lastObservedAt: live, invalidated: true };
  const file = path.join(cacheDirectory(home), `${id}.json`);
  await fs.writeFile(file, JSON.stringify(persisted));
  const result = await readCacheSnapshot(id, home);
  assert.equal(result.warmth.state, "warm");
  assert.ok(result.warmth.remainingMs > 29 * MINUTE && result.warmth.remainingMs <= 30 * MINUTE);
  assert.equal(result.cost.usd, result.cost.uncachedUsd);
  // New monitor invalidations still override history (provider changes, reroutes).
  await fs.writeFile(file, JSON.stringify({ ...persisted, cacheSchemaVersion: 2 }));
  assert.equal((await readCacheSnapshot(id, home)).warmth.state, "unknown");
});

test("discovery avoids overlapping resumed history and ignores stale monitor state", async (t) => {
  const root = await temporary(t);
  const home = path.join(root, "codexzero");
  const sessions = path.join(root, "sessions", "2026", "01", "01");
  const id = "overlap_thread";
  const live = Date.now();
  const liveAt = offset => new Date(live + offset).toISOString();
  await fs.mkdir(sessions, { recursive: true });
  const records = (firstAt, tokenAt, amount) => [
    { timestamp: liveAt(firstAt), type: "session_meta", payload: { id } },
    turn(liveAt(firstAt)), tokens(liveAt(tokenAt), amount),
  ].map(line).join("");
  const earlier = usage(100, 20, 0, 10);
  const authoritative = usage(70, 30, 0, 7);
  await fs.writeFile(path.join(sessions, `rollout-one-${id}.jsonl`), records(-5 * MINUTE, -3 * MINUTE, earlier));
  await fs.writeFile(path.join(sessions, `rollout-two-${id}.jsonl`), records(-4 * MINUTE, -3 * MINUTE, authoritative));
  await fs.mkdir(cacheDirectory(home), { recursive: true });
  await fs.writeFile(path.join(cacheDirectory(home), `${id}.json`), JSON.stringify({
    id, model: "unknown-old-model", lastObservedAt: live - 10 * MINUTE, invalidated: true,
    error: "Refresh paused", cost: { usd: 0, uncachedUsd: 0, partial: false }, requests: 0, pricedRequests: 0,
  }));

  const result = await readCacheSnapshot(id, home);
  assert.equal(result.cost.usd, priceUsage("gpt-6-astra", authoritative).usd);
  assert.equal(result.cost.partial, true);
  assert.equal(result.error, null);
  assert.notEqual(result.warmth.state, "unknown");
});

test("an entirely unpriced snapshot reports an unknown cost rather than zero", async (t) => {
  const home = await temporary(t);
  await fs.mkdir(cacheDirectory(home), { recursive: true });
  await fs.writeFile(path.join(cacheDirectory(home), "unpriced.json"), JSON.stringify({
    id: "unpriced", model: "unknown-model", requests: 2, pricedRequests: 0,
    cost: { usd: 0, uncachedUsd: 0, partial: true },
  }));
  const result = await readCacheSnapshot("unpriced", home);
  assert.equal(result.cost.usd, null);
  assert.equal(result.cost.uncachedUsd, null);
  assert.equal(result.cost.partial, true);
});

test("rollout reader appends incrementally, preserves a partial final line, and does not rebill on rereads or restart", async (t) => {
  const { file } = await makeRollout(t);
  const records = rolloutRecords();
  const complete = records.slice(0, 2).map(line).join("");
  const pending = line(records[2]);
  await fs.writeFile(file, complete + pending.slice(0, -1));

  const reader = new CacheRolloutReader("thread_reader", file);
  assert.equal((await reader.read()).requests, 0);
  await fs.appendFile(file, "\n");
  assert.equal((await reader.read()).requests, 1);
  assert.equal((await reader.read()).requests, 1);

  await fs.appendFile(file, pending);
  assert.equal((await reader.read()).requests, 1);
  const restarted = new CacheRolloutReader("thread_reader", file);
  assert.equal((await restarted.read()).requests, 1);
  assert.equal((await restarted.read()).requests, 1);
});

test("a late Fast hint replays an already observed turn exactly once at the correct rate", async (t) => {
  const turnId = "late_fast_turn";
  const { file } = await makeRollout(t, rolloutRecords({ turnId }));
  const reader = new CacheRolloutReader("late_hint", file);
  let snapshot = await reader.read();
  assert.deepEqual(snapshot.cost, { ...priceUsage("gpt-6-astra", usage(100, 20, 0, 10)), partial: false });

  reader.turnHints = { [turnId]: { tier: "fast", model: "gpt-6-astra" } };
  snapshot = await reader.read();
  assert.equal(snapshot.requests, 1);
  assert.deepEqual(snapshot.cost, { ...priceUsage("gpt-6-astra", usage(100, 20, 0, 10), "fast"), partial: false });
});

test("monitor sends the exact keep warm message once to an eligible idle OpenAI thread and releases its lease on completion", async (t) => {
  const { home, file } = await makeRollout(t);
  const id = "idle_thread";
  const { calls, rpc } = rpcRecorder(id);
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => monitor.close());
  const result = { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" };
  await quietRemember(monitor, result);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  await monitor.tick();

  const starts = calls.filter((call) => call.method === "turn/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.threadId, id);
  assert.deepEqual(starts[0].params.input, [{ type: "text", text: KEEP_WARM_MESSAGE, text_elements: [] }]);

  await monitor.tick();
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  const lease = path.join(cacheDirectory(home), `${id}.lease`);
  assert.equal(await fs.access(lease).then(() => true, () => false), true);
  monitor.notify({ method: "turn/completed", params: { threadId: id, turn: { status: "completed" } } });
  await waitForFile(lease, false);
  assert.equal(await fs.access(lease).then(() => true, () => false), false);
  assert.equal(monitor.warming.has(id), false);
});

test("monitor never refreshes an active thread, a thread with queued activity, or a disabled setting", async (t) => {
  const cases = [
    ["active_thread", { type: "active" }, false],
    ["queued_thread", { type: "idle" }, true],
    ["disabled_thread", { type: "idle" }, false],
  ];
  for (const [id, status, queuedActivity] of cases) {
    const { home, file } = await makeRollout(t);
    const { calls, rpc } = rpcRecorder(id);
    const monitor = new CacheMonitor({
      home,
      rpc,
      isBusy: () => false,
      enqueue: (_id, task) => task(),
      now: () => NOW,
    });
    t.after(() => monitor.close());
    await quietRemember(monitor, { thread: { id, path: file, status }, model: "gpt-6-astra", modelProvider: "openai" });
    await saveCacheSettings({ enabled: id !== "disabled_thread", minutes: 30 }, home);
    if (queuedActivity) monitor.userActivity(id);
    await monitor.tick();
    assert.equal(calls.filter((call) => call.method === "turn/start").length, 0, id);
  }
});

test("a ping does not renew activity or prevent an otherwise eligible refresh", async (t) => {
  const { home, file } = await makeRollout(t);
  const id = "activity_thread";
  const { calls, rpc } = rpcRecorder(id);
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const before = monitor.threads.get(id).lastUserAt;
  monitor.notify({ method: "ping", params: { threadId: id } });
  assert.equal(monitor.threads.get(id).lastUserAt, before);
  await monitor.tick();
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
});

test("persisted turn hints restore Fast pricing after a monitor and reader restart", async (t) => {
  const id = "hint_thread";
  const turnId = "turn_fast";
  const records = rolloutRecords({ turnId });
  const { home, file } = await makeRollout(t, records);
  const first = new CacheMonitor({
    home,
    rpc: async () => ({}),
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => first.close());
  await quietRemember(first, {
    thread: { id, path: file, status: { type: "idle" } },
    model: "gpt-6-astra",
    serviceTier: "fast",
    modelProvider: "openai",
  });
  first.select(id, { serviceTier: "fast" }, "gpt-6-astra");
  first.notify({ method: "turn/started", params: { threadId: id, turn: { id: turnId } } });
  const hintPath = path.join(cacheDirectory(home), `${id}.turns.json`);
  const hints = await waitForJson(hintPath, (value) => value[turnId]?.tier === "fast", "persisted turn hint");
  assert.deepEqual(hints[turnId], { tier: "fast", model: "gpt-6-astra" });
  first.close();

  const restarted = new CacheMonitor({
    home,
    rpc: async () => ({}),
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => restarted.close());
  await quietRemember(restarted, {
    thread: { id, path: file, status: { type: "idle" } },
    model: "gpt-6-astra",
    modelProvider: "openai",
  });
  await restarted.tick();
  const snapshot = JSON.parse(await fs.readFile(path.join(cacheDirectory(home), `${id}.json`), "utf8"));
  const expected = priceUsage("gpt-6-astra", usage(100, 20, 0, 10), "fast");
  assert.equal(snapshot.pricedRequests, 1);
  assert.deepEqual(snapshot.cost, { ...expected, partial: false });
});

test("two monitors share a lease and cooldown so one task receives one refresh", async (t) => {
  const id = "shared_thread";
  const { home, file } = await makeRollout(t);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, model: "gpt-6-astra", status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "shared_refresh" } };
    throw new Error(`unexpected RPC ${method}`);
  };
  const makeMonitor = () => new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  const first = makeMonitor();
  const second = makeMonitor();
  t.after(() => { first.close(); second.close(); });
  const result = { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" };
  await quietRemember(first, result);
  await quietRemember(second, result);
  await Promise.all([first.tick(), second.tick()]);
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);

  const warming = [first, second].find((monitor) => monitor.warming.has(id));
  assert.ok(warming);
  warming.notify({ method: "turn/completed", params: { threadId: id, turn: { status: "completed" } } });
  await waitForFile(path.join(cacheDirectory(home), `${id}.lease`), false);
  await Promise.all([first.tick(), second.tick()]);
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
});

test("disabling settings while work is queued prevents the refresh RPC", async (t) => {
  const id = "queued_disable";
  const { home, file } = await makeRollout(t);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, model: "gpt-6-astra", status: { type: "idle" } } };
    if (method === "turn/start") return { turn: { id: "should_not_start" } };
    throw new Error(`unexpected RPC ${method}`);
  };
  let queued;
  let release;
  const queuedResult = new Promise((resolve, reject) => {
    release = () => Promise.resolve().then(() => queued()).then(resolve, reject);
  });
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => { queued = task; return queuedResult; },
    now: () => NOW,
  });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  const tick = monitor.tick();
  await waitUntil(() => typeof queued === "function", "queued refresh");
  await saveCacheSettings({ enabled: false, minutes: 30 }, home);
  await release();
  await tick;
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 0);
});

test("expired, unknown, and custom provider caches never send a refresh", async (t) => {
  const cases = [
    { id: "expired_cache", records: rolloutRecords({ cacheAt: -31 * MINUTE }), model: "gpt-6-astra", provider: "openai" },
    { id: "unknown_cache", records: rolloutRecords({ model: "unknown-model" }), model: "unknown-model", provider: "openai" },
    { id: "custom_cache", records: rolloutRecords(), model: "gpt-6-astra", provider: "local" },
  ];
  for (const item of cases) {
    const { home, file } = await makeRollout(t, item.records);
    await saveCacheSettings({ enabled: true, minutes: 30 }, home);
    const { calls, rpc } = rpcRecorder(item.id, item.model);
    const monitor = new CacheMonitor({
      home,
      rpc,
      isBusy: () => false,
      enqueue: (_id, task) => task(),
      now: () => NOW,
    });
    t.after(() => monitor.close());
    await quietRemember(monitor, { thread: { id: item.id, path: file, status: { type: "idle" } }, model: item.model, modelProvider: item.provider });
    await monitor.tick();
    assert.equal(calls.filter((call) => call.method === "turn/start").length, 0, item.id);
  }
});

test("refresh completion does not move the original user activity timestamp", async (t) => {
  const id = "activity_stable";
  const { home, file } = await makeRollout(t);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const { calls, rpc } = rpcRecorder(id);
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  await monitor.tick();
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  const snapshotPath = path.join(cacheDirectory(home), `${id}.json`);
  const original = JSON.parse(await fs.readFile(snapshotPath, "utf8")).lastUserAt;
  monitor.notify({ method: "turn/completed", params: { threadId: id, turn: { status: "completed" } } });
  await waitForFile(path.join(cacheDirectory(home), `${id}.lease`), false);
  await monitor.tick();
  assert.equal(JSON.parse(await fs.readFile(snapshotPath, "utf8")).lastUserAt, original);
  assert.equal(monitor.threads.get(id).lastUserAt, undefined);
});

test("a failed refresh pauses further attempts", async (t) => {
  const id = "failed_refresh";
  const { home, file } = await makeRollout(t);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, model: "gpt-6-astra", status: { type: "idle" } } };
    if (method === "turn/start") throw new Error("simulated refresh failure");
    throw new Error(`unexpected RPC ${method}`);
  };
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  await monitor.tick();
  await monitor.tick();
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  assert.equal(monitor.threads.get(id).error, "Refresh paused");
  assert.equal(JSON.parse(await fs.readFile(path.join(cacheDirectory(home), `${id}.json`), "utf8")).error, "Refresh paused");
});

test("a transient refresh failure gets one safe retry while the cache is still cooling", async (t) => {
  const id = "retry_refresh";
  const { home, file } = await makeRollout(t, rolloutRecords({ cacheAt: -28 * MINUTE }));
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  let clock = NOW;
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, model: "gpt-6-astra", status: { type: "idle" } } };
    if (method === "turn/start") throw new Error("temporary failure");
    throw new Error(`unexpected RPC ${method}`);
  };
  const monitor = new CacheMonitor({ home, rpc, isBusy: () => false,
    enqueue: (_id, task) => task(), now: () => clock });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  await monitor.tick();
  clock += 61_000;
  await monitor.tick();
  assert.equal(calls.filter(call => call.method === "turn/start").length, 2);
});

test("cancel waits for the refresh turn to complete before a real turn can proceed", async (t) => {
  const id = "cancel_refresh";
  const { home, file } = await makeRollout(t);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const calls = [];
  let resolveStart;
  const startResult = new Promise((resolve) => { resolveStart = resolve; });
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") return { thread: { id, model: "gpt-6-astra", status: { type: "idle" } } };
    if (method === "turn/start") return startResult;
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected RPC ${method}`);
  };
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  const tick = monitor.tick();
  await waitUntil(() => monitor.warming.has(id), "warming refresh");
  const cancel = monitor.cancel(id);
  await immediate();
  assert.equal(calls.filter((call) => call.method === "turn/interrupt").length, 0);
  resolveStart({ turn: { id: "refresh_turn" } });
  await tick;
  await waitUntil(() => calls.some((call) => call.method === "turn/interrupt"), "interrupt RPC");
  assert.equal(calls.at(-1).params.turnId, "refresh_turn");
  monitor.notify({ method: "turn/completed", params: { threadId: id, turn: { status: "interrupted" } } });
  await cancel;
  assert.equal(monitor.warming.has(id), false);

  monitor.notify({ method: "turn/started", params: { threadId: id, turn: { id: "real_turn" } } });
  monitor.notify({ method: "turn/completed", params: { threadId: id, turn: { status: "completed" } } });
  assert.equal(monitor.threads.get(id).lastUserAt, NOW);
  await monitor.close();
  assert.equal(await fs.access(path.join(cacheDirectory(home), `${id}.lease`)).then(() => true, () => false), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(cacheDirectory(home), `${id}.turns.json`), "utf8")).real_turn.model, "gpt-6-astra");
});

test("closing a monitor with a warming turn leaves no unhandled promise", async (t) => {
  const id = "close_refresh";
  const { home, file } = await makeRollout(t);
  await saveCacheSettings({ enabled: true, minutes: 30 }, home);
  const { rpc } = rpcRecorder(id);
  const monitor = new CacheMonitor({
    home,
    rpc,
    isBusy: () => false,
    enqueue: (_id, task) => task(),
    now: () => NOW,
  });
  t.after(() => monitor.close());
  await quietRemember(monitor, { thread: { id, path: file, status: { type: "idle" } }, model: "gpt-6-astra", modelProvider: "openai" });
  await monitor.tick();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const lease = path.join(cacheDirectory(home), `${id}.lease`);
  await monitor.close();
  await waitForFile(lease, false);
  await delay(25);
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
});
