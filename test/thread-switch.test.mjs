import assert from "node:assert/strict";
import test from "node:test";
import { holdToolbar, patchThreadSwitch } from "../src/thread-switch-patch.mjs";

// Minimal hook runtime: one component, effects run after render, frames on demand.
function runtime() {
  const frames = new Map(); let nextFrame = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const slots = []; let index = 0, effects = [], dirty = false;
  const React = {
    useRef(value) { const i = index++; slots[i] ??= { current: value }; return slots[i]; },
    useState(value) { const i = index++; slots[i] ??= { value }; return [slots[i].value, update => { slots[i].value = typeof update === "function" ? update(slots[i].value) : update; dirty = true; }]; },
    useEffect(effect, deps) { const i = index++; const old = slots[i]; if (!old || deps.some((d, k) => d !== old.deps[k])) { effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; }); } else slots[i] = old; },
  };
  const render = visible => { index = 0; effects = []; const value = holdToolbar(React, visible); for (const run of effects) run(); return value; };
  const frame = () => { const pending = [...frames.values()]; frames.clear(); for (const f of pending) f(); };
  return { render, frame, isDirty: () => { const d = dirty; dirty = false; return d; }, frames };
}

test("a toolbar gap inside one switch never changes the height", () => {
  const r = runtime();
  assert.equal(r.render(true), true);
  assert.equal(r.render(false), true, "gap while the next thread mounts keeps the height");
  assert.equal(r.render(true), true);
  r.frame(); r.frame();
  assert.equal(r.isDirty(), false, "no delayed collapse after the toolbar came back");
});

test("leaving for a page without a toolbar collapses after two frames", () => {
  const r = runtime();
  r.render(true);
  assert.equal(r.render(false), true);
  r.frame();
  assert.equal(r.isDirty(), false);
  r.frame();
  assert.equal(r.isDirty(), true);
  assert.equal(r.render(false), false);
});

test("pages that never had a toolbar are not affected", () => {
  const r = runtime();
  assert.equal(r.render(false), false);
  assert.equal(r.frames.size, 0);
});

test("the patch targets only the toolbar height and keeps the toolbar itself", () => {
  const source = 'let et=x;at={"--app-shell-main-toolbar-height":et?`var(--height-toolbar-pane)`:`0px`};children:[et?toolbar:null]';
  const patched = patchThreadSwitch(source);
  assert.ok(patched.includes('"--app-shell-main-toolbar-height":czHoldToolbar($K,et)?'));
  assert.ok(patched.includes("children:[et?toolbar:null]"));
  const hook = new Function("$K", patched.slice(0, patched.indexOf("let et=x")) + "return czHoldToolbar")();
  assert.equal(typeof hook, "function");
  assert.throws(() => patchThreadSwitch("nothing here"));
});
