import assert from "node:assert/strict";
import test from "node:test";
import { patchThreadPreload, preloadRuntime } from "../src/thread-preload-patch.mjs";
import { patchWarmThreadLimit } from "../src/task-responsiveness.mjs";

function harness({ threads = {}, roots = ["E:/repo"], gate = true } = {}) {
  const calls = [], pending = [];
  const atoms = { KE: "KE", QE: "QE", t5n: "t5n", XE: "XE" };
  const scope = {
    get(atom, id) {
      const thread = threads[id];
      if (atom === "KE") return thread != null;
      if (atom === "QE") return thread?.resumeState;
      if (atom === "t5n") return thread?.role ?? null;
      if (atom === "XE") return thread?.mode;
      throw new Error("unexpected atom");
    },
  };
  const deps = {
    ...atoms,
    Imn: async () => roots,
    P_: () => gate,
    Mb: (_scope, host) => ({ readInputsFor: host }),
    ep: (_scope, host) => ({ resumeConversation(params, options) {
      calls.push({ host, params, options });
      return new Promise(resolve => pending.push(() => resolve({ status: "ready" })));
    } }),
  };
  const globals = {};
  const run = new Function(...Object.keys(deps), "globalThis", preloadRuntime + "return{czRememberPreloadScope,czPreloadThread}");
  const api = run(...Object.values(deps), globals);
  api.czRememberPreloadScope(scope);
  return { ...api, calls, pending, globals, settle: () => { while (pending.length) pending.shift()(); } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("a cold local thread loads with its workspace and saved mode", async () => {
  const h = harness({ threads: { a: { resumeState: "needs_resume", mode: { mode: "code" } } } });
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

test("threads that are already loaded, loading, or remote are left alone", async () => {
  const h = harness({ threads: {
    ready: { resumeState: "resumed", role: { role: "owner" } },
    busy: { resumeState: "resuming" },
  } });
  assert.equal(await h.czPreloadThread("ready", "local"), false);
  assert.equal(await h.czPreloadThread("busy", "local"), false);
  assert.equal(await h.czPreloadThread("cloud", "remote-host"), false);
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

test("the patch needs every internal it uses", () => {
  const anchors = [
    "async function Imn(e,t,{allowProjectSourceRoots:n=!1}={})",
    "function ep(e,t){let n=e.get(tp);",
    "function Mb(e,t){return async(",
    "function P_(e,t){let n=e.get(F_);return n!=null&&n.checkGate(t)}",
    ",KE=uf($,(e,{get:t})=>t(t(d5n,e))!=null)",
    ",QE=zE(({resumeState:e})=>e)",
    ",t5n=uf($,(e,{get:t})=>{if(e==null)return null;",
    ",XE=zE(({latestCollaborationMode:e})=>e,",
  ];
  const row = "T=xf($),E=vf(bK)===`work`,D=bf(Kwi,n)";
  const source = anchors.join(";") + ";" + row;
  const patched = patchThreadPreload(source);
  assert.ok(patched.includes("T=czRememberPreloadScope(xf($))"));
  for (const anchor of anchors) assert.throws(() => patchThreadPreload(source.replace(anchor, "")));
  assert.throws(() => patchThreadPreload(source.replace(row, "")));
});

test("more recently left threads stay loaded", () => {
  assert.equal(patchWarmThreadLimit("var a,NUt=108e5,PUt=15e3,FUt=10,x;"), "var a,NUt=108e5,PUt=15e3,FUt=24,x;");
  assert.throws(() => patchWarmThreadLimit("NUt=108e5,PUt=15e3,FUt=12,"));
  assert.throws(() => patchWarmThreadLimit("a=108e5,b=15e3,c=10,;d=108e5,e=15e3,f=10,"));
});
