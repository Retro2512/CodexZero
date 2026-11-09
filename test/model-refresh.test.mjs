import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_REFRESH_TARGET, patchModelRefresh } from "../src/model-refresh-patch.mjs";

const queryClient = "function eX(){let e=new eE.E(eH.LR);{let t=window.electronBridge?.getInitialSidebarBootstrap?.()??null}return e}";

test("model lists refresh every five minutes while the window is in front", () => {
  const source = `const before=1;${queryClient};const after="core_providers.render";`;
  const patched = patchModelRefresh(source);
  assert.ok(patched.includes('let e=new eE.E(eH.LR);e.setQueryDefaults(["models","list"],{refetchInterval:3e5,refetchIntervalInBackground:!1});{let t='));
  assert.equal(patched.replace('e.setQueryDefaults(["models","list"],{refetchInterval:3e5,refetchIntervalInBackground:!1});', ""), source);
  assert.ok(source.includes(MODEL_REFRESH_TARGET));
});

test("the defaults reach every model list query, including team catalogs", () => {
  const defaults = new Map();
  const client = { setQueryDefaults: (key, options) => defaults.set(JSON.stringify(key), options) };
  const run = new Function("eE", "eH", "window", patchModelRefresh(queryClient) + ";return eX()");
  run({ E: function () { return client; } }, { LR: {} }, {});
  assert.deepEqual(defaults.get('["models","list"]'), { refetchInterval: 300000, refetchIntervalInBackground: false });
});

test("model refresh rejects missing or duplicate anchors", () => {
  assert.throws(() => patchModelRefresh("unrecognized bundle"), /updated model refresh patch/);
  assert.throws(() => patchModelRefresh(`${queryClient};${queryClient}`), /updated model refresh patch/);
});
