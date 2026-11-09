import fs from "node:fs/promises";
import { locateTargets, openAsar } from "./asar-patch.mjs";

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error(`Unsupported sidebar bundle anchor: ${before.slice(0,90)}`);
  }
  return source.replace(before, () => after);
}

// Deliberately opt in through the preview builder, not through the release
// builder. Test one inherited graphics change without changing cache behavior,
// task persistence, browser lifetime, or model streaming semantics.
export const SIDEBAR_RENDERER_TARGET = "initializeApp:()=>";

export function patchSidebarRenderer(source) {
  const result = replaceOnce(source,
    "disableBackdropBlur:!1,disableCssMotion:!1,disableScrollFadeMask:!1,disableScrollFadeMaskAnimation:!1,disableSquircles:!1,forceOpaqueRendererBackground:!1",
    "disableBackdropBlur:!1,disableCssMotion:!1,disableScrollFadeMask:!0,disableScrollFadeMaskAnimation:!0,disableSquircles:!1,forceOpaqueRendererBackground:!1");
  // Enable only the rendering isolation gate, not internal account features or
  // the unrestricted debug menu. Retain the hook invocation and hook ordering.
  return replaceOnce(result, 'l=(0,eg.Zj)("2423536643")', 'l=((0,eg.Zj)("2423536643"),!0)');
}

export const SIDEBAR_ITEM_INDEX_TARGET = "orderedItemIds";

export function patchSidebarItemIndex(source) {
  const result = replaceOnce(source, "c=$?.orderedItemIds.indexOf(E)??-1", "c=czSidebarItemIndex($?.orderedItemIds,E)");
  return 'import{sidebarItemIndex as czSidebarItemIndex}from"../codexzero-sidebar-performance.js";' + result;
}

export async function sidebarPerformanceReplacements(archivePath) {
  const archive = await openAsar(archivePath);
  try {
    const targets = await locateTargets(archive, [SIDEBAR_RENDERER_TARGET, SIDEBAR_ITEM_INDEX_TARGET], ["webview/assets"]);
    const replacements = new Map([["webview/assets/codexzero-sidebar-performance.js", await fs.readFile(new URL("../assets/sidebar-performance.mjs", import.meta.url))]]);
    for (const [target, patch] of [[SIDEBAR_RENDERER_TARGET, patchSidebarRenderer], [SIDEBAR_ITEM_INDEX_TARGET, patchSidebarItemIndex]]) {
      const name = targets.get(target);
      replacements.set(name, Buffer.from(patch((await archive.read(name)).toString("utf8"))));
    }
    const identityPath = ".vite/build/codexzero-identity.cjs";
    const identity = (await archive.read(identityPath)).toString("utf8");
    if (!identity.includes('"CodexZero.Desktop"')) throw new Error("Expected CodexZero identity");
    replacements.set(identityPath, Buffer.from(identity.replaceAll('"CodexZero.Desktop"', '"CodexZero.PerformancePreview"').replaceAll('"CodexZero"', '"CodexZero Preview"')));
    return replacements;
  } finally { await archive.close(); }
}
