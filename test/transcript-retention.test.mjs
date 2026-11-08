import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createTranscriptRetention, estimateRetainedBytes, estimateRetainedBytesLater, reconcileMaterializedTurns, transcriptRetention } from "../assets/transcript-retention.mjs";

function fixture(options = {}) {
  let time = 0, next = 0;
  const timers = new Map(), scope = {}, disposed = [];
  const cache = createTranscriptRetention({ ...options, now: () => time,
    schedule: callback => { timers.set(++next, callback); return next; }, cancel: id => timers.delete(id) });
  const key = id => ({ hostId: "local", threadId: id });
  const park = (id, data = { text: "hello" }, owner = scope) => cache.park(owner, key(id), data, [data], () => disposed.push(id));
  return { cache, scope, disposed, timers, key, park, time: value => time = value };
}

test("take is synchronous, cancels expiry and transfers ownership once", () => {
  const f = fixture();
  assert.equal(f.park("a"), true);
  assert.deepEqual(f.cache.take(f.scope, f.key("a")), { text: "hello" });
  assert.equal(f.cache.take(f.scope, f.key("a")), undefined);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.disposed, []);
});

test("expiry boundary never returns disposed data, even before timer dispatch", () => {
  const f = fixture(); f.park("a"); f.time(30000);
  assert.equal(f.cache.take(f.scope, f.key("a")), undefined);
  assert.deepEqual(f.disposed, ["a"]);
  assert.deepEqual(f.cache.stats(f.scope), { entries: 0, bytes: 0 });
});

test("stale queued expiry cannot evict a newly parked generation", () => {
  const f = fixture(); f.park("a"); const oldTimer = [...f.timers.values()][0];
  f.cache.take(f.scope, f.key("a")); f.park("a", { text: "new" }); oldTimer();
  assert.deepEqual(f.cache.take(f.scope, f.key("a")), { text: "new" });
  assert.deepEqual(f.disposed, []);
});

test("scope and host isolation", () => {
  const f = fixture(); f.park("a");
  assert.equal(f.cache.take({}, f.key("a")), undefined);
  assert.equal(f.cache.take(f.scope, { ...f.key("a"), hostId: "remote" }), undefined);
  assert.equal(f.cache.stats(f.scope).entries, 1);
});

test("least recently used dormant entries evict under count and byte limits", () => {
  const f = fixture({ maxEntries: 2 }); f.park("a"); f.park("b");
  const a = f.cache.take(f.scope, f.key("a")); f.park("a", a); f.park("c");
  assert.deepEqual(f.disposed, ["b"]);
  const g = fixture({ maxBytes: 500 }); g.park("a"); g.park("b");
  assert.deepEqual(g.disposed, ["a"]);
  assert.ok(g.cache.stats(g.scope).bytes <= 500);
});

test("oversized and complex graphs fall back without retention", () => {
  const f = fixture({ maxBytes: 500 });
  assert.equal(f.park("a", { text: "x".repeat(501) }), false);
  assert.equal(estimateRetainedBytes([Array(10001).fill(0)]), Infinity);
  assert.equal(estimateRetainedBytes([new Map()]), Infinity);
  assert.equal(estimateRetainedBytes([{ get text() { throw Error("not invoked"); } }]), Infinity);
  assert.deepEqual(f.cache.stats(f.scope), { entries: 0, bytes: 0 });
});

test("shared references and cycles are bounded, strings are charged", () => {
  const a = { text: "hello" }; a.self = a;
  assert.ok(Number.isFinite(estimateRetainedBytes([a])));
  assert.equal(estimateRetainedBytes([a, a]), estimateRetainedBytes([a]));
  assert.ok(estimateRetainedBytes([{ text: "longer text" }]) > estimateRetainedBytes([{ text: "x" }]));
});

test("eligibility traversal abandons a wide graph when its time budget expires", () => {
  const wide = Array.from({ length: 1000 }, (_, i) => i);
  assert.ok(Number.isFinite(estimateRetainedBytes([wide], 8 * 1024 * 1024,
    { clock: () => 0, maxTimeMs: 3 })));
  let ticks = 0;
  assert.equal(estimateRetainedBytes([wide], 8 * 1024 * 1024,
    { clock: () => ++ticks, maxTimeMs: 3 }), Infinity);
  assert.ok(ticks < 20, "wide traversal must stop well before visiting all fields");
  const f = fixture({ estimateClock: () => ++ticks, maxEstimateMs: 3 });
  assert.equal(f.park("wide", wide), false);
  assert.deepEqual(f.cache.stats(f.scope), { entries: 0, bytes: 0 });
});

test("duplicate park does not dispose the current record", () => {
  const f = fixture(); f.park("a"); assert.throws(() => f.park("a"));
  assert.equal(f.cache.stats(f.scope).entries, 1); assert.deepEqual(f.disposed, []);
});

test("scheduler failure rolls back ownership for caller fallback", () => {
  const scope = {}, c = createTranscriptRetention({ schedule() { throw Error("scheduler"); } });
  assert.throws(() => c.park(scope, { hostId: "l", threadId: "a" }, {}, [{}], () => {}));
  assert.deepEqual(c.stats(scope), { entries: 0, bytes: 0 });
});

test("deferred parking keeps a long transcript and measures it in slices", () => {
  const scheduled = [];
  const big = Array.from({ length: 50000 }, (_, i) => ({ id: i, text: "turn " + i }));
  let tick = 0, result;
  const stop = estimateRetainedBytesLater([big], 64 * 1024 * 1024, bytes => { result = bytes; },
    { clock: () => tick++, sliceMs: 50, schedule: cb => { scheduled.push(cb); return scheduled.length; }, cancel() {} });
  let slices = 0;
  while (scheduled.length) { scheduled.shift()(); slices++; }
  assert.ok(Number.isFinite(result) && result > 50000 * 256, "large transcript is measured, not rejected");
  assert.ok(slices > 10, "measurement is split across many slices");
  assert.equal(typeof stop, "function");
});

test("deferred parking accepts immediately and drops oversized entries after measuring", () => {
  const timers = [], scope = {}, disposed = [];
  let tick = 0;
  const cache = createTranscriptRetention({ deferEstimate: true, maxEntryBytes: 1000, maxEntries: 8,
    estimateClock: () => tick++, schedule: (cb, ms) => { timers.push({ cb, ms }); return timers.length; }, cancel() {} });
  const key = id => ({ hostId: "local", threadId: id });
  assert.equal(cache.park(scope, key("big"), "v", [{ text: "x".repeat(2000) }], () => disposed.push("big")), true);
  assert.equal(cache.park(scope, key("small"), "v", [{ text: "hi" }], () => disposed.push("small")), true);
  assert.equal(cache.stats(scope).entries, 2, "nothing is measured while switching");
  for (const t of timers.splice(0)) if (t.ms === 0) t.cb();
  while (timers.some(t => t.ms === 0)) { const i = timers.findIndex(t => t.ms === 0); timers.splice(i, 1)[0].cb(); }
  assert.deepEqual(disposed, ["big"]);
  assert.equal(cache.stats(scope).entries, 1);
  assert.ok(cache.stats(scope).bytes > 0);
});

test("taking a thread back before it is measured cancels the measurement", () => {
  const timers = [], scope = {}, disposed = [];
  const cache = createTranscriptRetention({ deferEstimate: true, maxEntries: 8,
    schedule: (cb, ms) => { timers.push({ cb, ms }); return timers.length; }, cancel() {} });
  const key = { hostId: "local", threadId: "a" };
  cache.park(scope, key, "value", [{ text: "hi" }], () => disposed.push("a"));
  assert.equal(cache.take(scope, key), "value");
  for (const t of timers) if (t.ms === 0) t.cb();
  assert.deepEqual(disposed, []);
  assert.deepEqual(cache.stats(scope), { entries: 0, bytes: 0 });
});

test("the app keeps eight recent threads warm", () => {
  const scope = {}, key = id => ({ hostId: "local", threadId: id }), disposed = [];
  for (let i = 0; i < 9; i++) transcriptRetention.park(scope, key(String(i)), i, [{ text: "t" }], () => disposed.push(i));
  assert.deepEqual(disposed, [0]);
  assert.equal(transcriptRetention.stats(scope).entries, 8);
  for (let i = 1; i < 9; i++) transcriptRetention.take(scope, key(String(i)));
});

function turns() {
  const details = { status: "completed", turnId: "a" }, slots = { length: 1, entries: [{ index: 0, itemId: "i" }] };
  const item = { type: "message", text: "original" }, materialized = { ...details, items: [item] };
  const map = new Map([["a", materialized]]);
  const snapshot = { turnsByKey: { a: { details, itemSlots: slots } }, itemsByKey: { "a:i": item } };
  const previous = () => ({ details, slots, itemKey: id => `a:${id}`, item: () => item });
  return { map, snapshot: structuredClone(snapshot), previous, materialized };
}

test("authoritatively identical reset preserves materialized identity", () => {
  const t = turns(); reconcileMaterializedTurns(t.map, t.snapshot, t.previous, isDeepStrictEqual);
  assert.equal(t.map.get("a"), t.materialized);
});

for (const change of ["text", "details", "slots", "deleted", "missingItem"]) {
  test(`authoritative ${change} invalidates retained materialization`, () => {
    const t = turns();
    if (change === "text") t.snapshot.itemsByKey["a:i"].text = "reverted";
    if (change === "details") t.snapshot.turnsByKey.a.details.status = "interrupted";
    if (change === "slots") t.snapshot.turnsByKey.a.itemSlots.entries = [];
    if (change === "deleted") delete t.snapshot.turnsByKey.a;
    if (change === "missingItem") delete t.snapshot.itemsByKey["a:i"];
    reconcileMaterializedTurns(t.map, t.snapshot, t.previous, isDeepStrictEqual);
    assert.equal(t.map.size, 0);
  });
}
