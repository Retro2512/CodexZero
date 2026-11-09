import assert from "node:assert/strict";
import test from "node:test";
import { THREAD_PRELOAD_TARGET, patchThreadPreload, preloadRuntime } from "../src/thread-preload-patch.mjs";
import { patchWarmThreadLimitMain, patchWarmThreadLimitRenderer } from "../src/task-responsiveness.mjs";

function harness({ modes = {}, roots = ["E:/repo"], gate = true } = {}) {
  const calls = [], pending = [];
  const scope = {
    get(atom, id) {
      if (atom === "collaborationMode") return modes[id];
      throw new Error("unexpected atom");
    },
  };
  const modules = {
    MLeN: { A: async (_scope, _id, options) => (assert.deepEqual(options, { allowProjectSourceRoots: true }), roots) },
    OMIV: { ie: (_scope, gateId) => gateId === "4226282475" && gate },
    tl5a: { aG: "collaborationMode" },
    shRG: { jQ: (_scope, host) => ({ readInputsFor: host }) },
    Dgwo: { V: (_scope, host) => ({ resumeConversation(params, options) {
      calls.push({ host, params, options });
      return new Promise(resolve => pending.push(() => resolve({ status: "ready" })));
    } }) },
  };
  const globals = {};
  const api = new Function("globalThis", preloadRuntime + "return{czRememberPreloadScope,czPreloadThread,load:r=>{czPreloadRequire=r}}")(globals);
  api.czRememberPreloadScope(scope);
  api.load(id => modules[id]);
  return { ...api, calls, pending, globals, settle: () => { while (pending.length) pending.shift()(); } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("a cold local thread loads with its workspace and saved mode", async () => {
  const h = harness({ modes: { a: { mode: "code" } } });
  const done = h.czPreloadThread("a", "local");
  await flush();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].params, { conversationId: "a", model: null, reasoningEffort: null, workspaceRoots: ["E:/repo"],
    useAppServerPermissionDefault: true, collaborationMode: { mode: "code" }, showThreadGoalResumeConfirmation: false });
  assert.deepEqual(h.calls[0].options, { readResumeInputs: { readInputsFor: "local" } });
  h.settle();
  assert.equal(await done, true);
  assert.equal(typeof h.globals.codexZeroPreloadThread, "function");
});

test("remote threads and a sidebar that has not rendered yet are left alone", async () => {
  const h = harness();
  assert.equal(await h.czPreloadThread("cloud", "remote-host"), false);
  assert.equal(await h.czPreloadThread(""), false);
  const idle = new Function("globalThis", preloadRuntime + "return czPreloadThread")({});
  assert.equal(await idle("a"), false);
  assert.equal(h.calls.length, 0);
});

test("at most two threads load at once and each is tried once per thirty seconds", async () => {
  const h = harness();
  const first = [h.czPreloadThread("a"), h.czPreloadThread("b"), h.czPreloadThread("c")];
  await flush();
  assert.deepEqual(h.calls.map(call => call.params.conversationId), ["a", "b"]);
  h.settle();
  await Promise.all(first);
  assert.equal(await h.czPreloadThread("a"), false, "recently tried thread is skipped");
  const again = h.czPreloadThread("c");
  await flush();
  h.settle();
  assert.equal(await again, true);
});

test("a thread whose project is still unknown is not loaded with a guess", async () => {
  const h = harness({ roots: null });
  assert.equal(await h.czPreloadThread("a"), false);
  assert.equal(h.calls.length, 0);
});

test("the sidebar row module hands over the app scope and module loader", () => {
  const header = ",oprL(e,t,a){a.d(t,{E:()=>e_,T:()=>eR});var n=a(\"ABep\")";
  const row = "tp=(0,i.gh)(F.u),{previewNavigationState:tf}=(0,d.useContext)(Z.I),tF=(0,ew.Zj)(\"2337831332\")";
  const source = header + ";" + row;
  const patched = patchThreadPreload(source);
  assert.ok(patched.startsWith(preloadRuntime));
  assert.ok(patched.includes("a.d(t,{E:()=>e_,T:()=>eR});czPreloadRequire=a;var n="));
  assert.ok(patched.includes("tp=czRememberPreloadScope((0,i.gh)(F.u)),{previewNavigationState:tf}"));
  assert.ok(source.includes(THREAD_PRELOAD_TARGET));
  assert.throws(() => patchThreadPreload(row));
  assert.throws(() => patchThreadPreload(header));
  assert.throws(() => patchThreadPreload(patched));
});

test("more recently left threads stay loaded", () => {
  const source = 'let r=t.filter(e=>!e.isEphemeralSideConversation),n=Math.max(0,r.length-10),i=new Set(r.slice(0,n));log({maxInactiveOwnerThreads:10,overage:n})';
  for (const patch of [patchWarmThreadLimitMain, patchWarmThreadLimitRenderer]) {
    assert.equal(patch(source), source.replace("length-10)", "length-24)").replace("Threads:10,", "Threads:24,"));
    assert.throws(() => patch(source.replace("length-10)", "length-12)")));
    assert.throws(() => patch(source + source));
  }
});
