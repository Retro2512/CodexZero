import assert from "node:assert/strict";
import test from "node:test";
import { sidebarItemIndex } from "../assets/sidebar-performance.mjs";
import { patchSidebarItemIndex, patchSidebarRenderer, replaceOnce } from "../src/sidebar-performance.mjs";

const renderer = 'let r=(0,a.vP)(i.u,{disableBackdropBlur:!1,disableCssMotion:!1,disableScrollFadeMask:!1,disableScrollFadeMaskAnimation:!1,disableSquircles:!1,forceOpaqueRendererBackground:!1});function mw(){let o=(0,E.Ul)(mf.J),l=(0,eg.Zj)("2423536643");return l&&o.disableScrollFadeMask}';
const row = 'D[8]!==$?.orderedItemIds||D[9]!==E?(c=$?.orderedItemIds.indexOf(E)??-1,D[8]=$?.orderedItemIds,D[9]=E,D[10]=c):c=D[10];';

test("performance preview defaults disable only scroll masks and their animation", () => {
  const result = patchSidebarRenderer(renderer);
  assert.match(result, /disableScrollFadeMask:!0,disableScrollFadeMaskAnimation:!0/);
  assert.match(result, /disableBackdropBlur:!1,disableCssMotion:!1/);
  assert.match(result, /disableSquircles:!1,forceOpaqueRendererBackground:!1/);
  assert.ok(result.includes('l=((0,eg.Zj)("2423536643"),!0)'));
});

test("sortable rows look up their index through the cached helper", () => {
  const result = patchSidebarItemIndex(row);
  assert.ok(result.includes("c=czSidebarItemIndex($?.orderedItemIds,E),D[8]"));
  assert.ok(result.startsWith('import{sidebarItemIndex as czSidebarItemIndex}from"../codexzero-sidebar-performance.js";'));
});

test("versioned patches reject missing, ambiguous, and already patched anchors", () => {
  assert.throws(() => replaceOnce("abc", "missing", "x"), /Unsupported/);
  assert.throws(() => replaceOnce("abc abc", "abc", "x"), /Unsupported/);
  assert.throws(() => patchSidebarRenderer(renderer.replace('(0,eg.Zj)("2423536643")', "different()")), /Unsupported/);
  assert.throws(() => patchSidebarRenderer(patchSidebarRenderer(renderer)), /Unsupported/);
  assert.throws(() => patchSidebarItemIndex(row + row), /Unsupported/);
  assert.throws(() => patchSidebarItemIndex(patchSidebarItemIndex(row)), /Unsupported/);
});

test("indexed lookup preserves first match, zero index, missing values and reorders", () => {
  assert.equal(sidebarItemIndex(undefined, "x"), -1);
  assert.equal(sidebarItemIndex(null, "x"), -1);
  for (const items of [[], ["a"], ["a", "b", "a"], ["b", "a"]]) {
    Object.freeze(items);
    for (const key of ["a", "b", "absent"]) {
      assert.equal(sidebarItemIndex(items, key), items.indexOf(key));
      assert.equal(sidebarItemIndex(items, key), items.indexOf(key));
    }
  }
});

test("repeated row lookups do not rescan the ordered array", () => {
  let reads = 0;
  const items = new Proxy(Object.freeze(["a", "b", "c"]), {
    get(target, key) { if (/^\d+$/.test(String(key))) reads++; return Reflect.get(target, key); },
  });
  assert.equal(sidebarItemIndex(items, "b"), 1);
  const initialReads = reads;
  for (let i = 0; i < 100; i++) assert.equal(sidebarItemIndex(items, "c"), 2);
  assert.equal(reads, initialReads);
});
