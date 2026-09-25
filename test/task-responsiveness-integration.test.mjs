import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { openAsar } from "../src/asar-patch.mjs";
import { patchTranscriptRetention } from "../src/task-responsiveness.mjs";
import { createTranscriptRetention, reconcileMaterializedTurns } from "../assets/transcript-retention.mjs";

const archivePath = process.env.CODEXZERO_TEST_ASAR || "work/local-providers/20260921-reasoning-picker/desktop/resources/app.asar";

test("real bundled transcript lifecycle retains data but never skips authoritative validation", { skip: !fs.existsSync(archivePath) }, async () => {
  const archive = await openAsar(archivePath);
  let source;
  try { source = (await archive.read("webview/assets/app-initial-6c4523b43a11.js")).toString(); }
  finally { await archive.close(); }
  const patched = patchTranscriptRetention(source);
  assert.throws(() => patchTranscriptRetention(patched));
  assert.throws(() => patchTranscriptRetention(source.replace("r.current=a;let o=new Map", "r.current=a;let o=unknown")));
  const start = patched.indexOf("AI=lf($,e=>`loading`");
  const end = patched.indexOf(",jI=", start);
  assert.ok(start > 0 && end > start);
  const tokens = ["Qci", "eli", "kI", "tli", "OI", "Zci", "nli", "rli", "ili", "ali", "oli", "D_", "O_"];
  const atoms = new Map(), pending = [], records = new Map(), microtasks = [];
  let disposals = 0, ownerDisposals = 0, currentClient, now = 0;
  const timers = new Map(); let sequence = 0;
  const retention = createTranscriptRetention({ now: () => now, schedule: f => { timers.set(++sequence, f); return sequence; }, cancel: id => timers.delete(id) });
  const key = (token, arg) => token + JSON.stringify(arg);
  const scope = {
    node: {},
    get(token, arg) { if (token === "O_") return currentClient; return atoms.get(key(token, arg)) ?? null; },
    set(token, arg, value) { const k = key(token, arg); atoms.set(k, typeof value === "function" ? value(atoms.get(k) ?? null) : value); },
    watch(callback) { const stop = callback({ get: () => ({ client: currentClient, status: "ready" }) }); return stop || (() => {}); },
  };
  const client = { rpc: { subscribe({ listener }) {
    pending.push(listener);
    const response = new Promise(() => {});
    response.onRpcBroken = () => {};
    response[Symbol.dispose] = () => disposals++;
    return response;
  } } };
  currentClient = client;
  const context = {
    ...Object.fromEntries(tokens.map(t => [t, t])), $: {}, AI: null,
    czTranscriptRetention: retention, czReconcileTurns: reconcileMaterializedTurns,
    DI: { default: isDeepStrictEqual }, lf: (_, initial, start) => ({ initial, start }),
    _d: (_, fn) => fn(), vBt: (a, b) => `${a}:${b}`, EI: e => JSON.stringify(e),
    Xci: e => ({ hostId: e.hostId, threadId: e.threadId, itemKey: `${e.entityKey}:${e.itemId}` }),
    m_t: () => ownerDisposals++, queueMicrotask: fn => microtasks.push(fn),
    Kci: (item, change) => ({ ...item, text: item.text + change.delta }),
  };
  const projection = new Function(...Object.keys(context), patched.slice(start, end) + ";return AI;")(...Object.values(context));
  const task = { hostId: "local", threadId: "a" };
  function mount(e = task) {
    const recordKey = JSON.stringify(e);
    if (!records.has(recordKey)) records.set(recordKey, { current: null, scope });
    const r = records.get(recordKey), states = [];
    const stop = projection.start(e, { get: () => r, set: state => states.push(state) });
    return { stop, states, r, deliver: pending.at(-1) };
  }
  const snapshot = text => ({ type: "reset", value: {
    turnsByKey: { t: { details: { turnId: "t", status: "completed" }, itemSlots: { length: 1, entries: [{ index: 0, itemId: "i" }] }, hasSubagentActivity: false } },
    itemsByKey: { "t:i": { type: "message", text } }, turnEntityKeys: ["t"],
    realtimeItems: {}, itemTimeline: { entries: [] }, timeline: [], historyComplete: true, compactHistoryComplete: true,
  } });
  const first = mount(); first.deliver(snapshot("original"));
  const materialized = { turnId: "t", status: "completed", items: [{ type: "message", text: "original" }] };
  first.r.current.materializedTurns.set("t", materialized);
  assert.equal(first.states.at(-1), "ready"); first.stop();
  assert.equal(disposals, 1, "park must stop the live RPC immediately");
  assert.equal(retention.stats(scope.node).entries, 1);
  assert.equal(ownerDisposals, 0);

  const second = mount();
  assert.equal(second.states.at(-1), "loading", "cached text must not appear before validation");
  assert.equal(second.r.current.materializedTurns.get("t"), materialized);
  second.deliver(snapshot("original"));
  assert.equal(second.states.at(-1), "ready");
  assert.equal(second.r.current.materializedTurns.get("t"), materialized);
  // Late messages from the stopped first subscription cannot overwrite new data.
  first.deliver(snapshot("late old callback"));
  assert.equal(scope.get("Qci", { ...task, itemKey: "t:i" }).text, "original");
  second.deliver({ type: "delta", changes: [{ type: "text", key: { ...task, entityKey: "t", itemId: "i" }, delta: " streamed" }] });
  assert.equal(second.r.current.materializedTurns.size, 0);
  assert.equal(scope.get("Qci", { ...task, itemKey: "t:i" }).text, "original streamed");
  second.stop();

  const third = mount(); third.deliver(snapshot("reverted"));
  assert.equal(scope.get("Qci", { ...task, itemKey: "t:i" }).text, "reverted");
  third.deliver({ type: "reset", value: null });
  assert.equal(third.states.at(-1), "missing");
  assert.equal(scope.get("Qci", { ...task, itemKey: "t:i" }), null);
  third.stop(); assert.equal(retention.stats(scope.node).entries, 0);

  // A queued purge from an older generation must not dispose a reopened and
  // subsequently parked projection, even though current is null again.
  const fourth = mount(); fourth.deliver(snapshot("new")); fourth.stop();
  for (const fn of microtasks.splice(0)) fn();
  assert.equal(ownerDisposals, 0);
  now = 30000;
  for (const fn of [...timers.values()]) fn();
  for (const fn of microtasks.splice(0)) fn();
  assert.equal(ownerDisposals, 1);
  assert.equal(retention.stats(scope.node).entries, 0);
});
