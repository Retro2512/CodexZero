import fs from "node:fs/promises";
import { openAsar } from "./asar-patch.mjs";

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) {
    throw new Error(`Unsupported sidebar bundle anchor: ${before.slice(0,90)}`);
  }
  return source.replace(before, after);
}

// Deliberately opt in through the preview builder, not through the release
// builder. Test one inherited graphics change without changing cache behavior,
// task persistence, browser lifetime, or model streaming semantics.
export function patchSidebarRenderer(source) {
  let result = replaceOnce(source,
    "disableBackdropBlur:!1,disableCssMotion:!1,disableScrollFadeMask:!1,disableScrollFadeMaskAnimation:!1,disableSquircles:!1,forceOpaqueRendererBackground:!1",
    "disableBackdropBlur:!1,disableCssMotion:!1,disableScrollFadeMask:!0,disableScrollFadeMaskAnimation:!0,disableSquircles:!1,forceOpaqueRendererBackground:!1");
  // Enable only the rendering isolation gate, not internal account features or
  // the unrestricted debug menu. Retain the hook invocation and hook ordering.
  result = replaceOnce(result, 'V_(`2423536643`)', '(V_(`2423536643`),!0)');
  result = replaceOnce(result, 'c?.orderedItemIds.indexOf(i)??-1', 'czSidebarItemIndex(c?.orderedItemIds,i)');
  return 'import{sidebarItemIndex as czSidebarItemIndex}from"./codexzero-sidebar-performance.js";\n' + result;
}

export async function sidebarPerformanceReplacements(archivePath) {
  const archive = await openAsar(archivePath);
  try {
    const names = Object.keys(archive.header.files.webview.files.assets.files);
    const initial = names.filter(name => /^app-initial-[\w-]+\.js$/.test(name));
    if (initial.length !== 1) throw new Error("Expected one initial renderer bundle");
    const name = `webview/assets/${initial[0]}`;
    const source = (await archive.read(name)).toString("utf8");
    const replacements = new Map([
      [name, Buffer.from(patchSidebarRenderer(source))],
      ["webview/assets/codexzero-sidebar-performance.js", await fs.readFile(new URL("../assets/sidebar-performance.mjs", import.meta.url))],
    ]);
    const identityPath = ".vite/build/codexzero-identity.cjs";
    const identity = (await archive.read(identityPath)).toString("utf8");
    if (!identity.includes('"CodexZero.Desktop"')) throw new Error("Expected CodexZero identity");
    replacements.set(identityPath, Buffer.from(identity.replaceAll('"CodexZero.Desktop"', '"CodexZero.PerformancePreview"').replaceAll('"CodexZero"', '"CodexZero Preview"')));
    return replacements;
  } finally { await archive.close(); }
}
