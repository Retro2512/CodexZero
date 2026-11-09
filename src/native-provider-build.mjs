import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openAsar, rewriteAsar, locateTargets, updateEmbeddedAsarIntegrity } from "./asar-patch.mjs";
import { codexZeroHome } from "./paths.mjs";
import { sidebarIdentityReplacements } from "./sidebar-identity-patch.mjs";
import { SIDEBAR_ITEM_INDEX_TARGET, SIDEBAR_RENDERER_TARGET, patchSidebarItemIndex, patchSidebarRenderer } from "./sidebar-performance.mjs";
import { WARM_THREAD_LIMIT_MAIN_TARGET, WARM_THREAD_LIMIT_RENDERER_TARGET, patchWarmThreadLimitMain, patchWarmThreadLimitRenderer } from "./task-responsiveness.mjs";
import { THREAD_PRELOAD_TARGET, patchThreadPreload } from "./thread-preload-patch.mjs";
import { SELECTION_SCROLL_TARGET, patchSelectionScroll } from "./scroll-scope-performance.mjs";
import { patchCopiedBrowserService } from "./browser-discovery-patch.mjs";
import { patchCopiedBrowserContinuation } from "./browser-continuation-patch.mjs";
import { NOTIFICATION_BOOTSTRAP_TARGET, NOTIFICATION_MAIN_TARGET, patchNotificationBootstrap, patchNotificationMain } from "./notification-routing-patch.mjs";
import { MODEL_REFRESH_TARGET, patchModelRefresh } from "./model-refresh-patch.mjs";
import { THREAD_VISIBILITY_MAIN_TARGET, THREAD_VISIBILITY_RENDERER_TARGET, patchThreadVisibilityMain, patchThreadVisibilityRenderer } from "./thread-visibility-patch.mjs";
import { CACHE_INDICATOR_TARGET, SETTINGS_PAGE_TARGET, patchCacheIndicator, patchSettingsPage } from "./settings-ui-patch.mjs";
import { LEAN_FILE_PATCHES, leanChunkReplacements, pruneCopiedDesktop } from "./lean-desktop-patch.mjs";

export async function prepareNativeProviderDesktop(installedDesktop, { home = codexZeroHome() } = {}) {
  if (process.platform !== "win32") throw new Error("Native custom model settings currently require the Windows local build");
  const source = path.resolve(import.meta.dirname, "..");
  const hash = createHash("sha256");
  const packageBytes = await fs.readFile(path.join(source, "package.json"));
  hash.update(packageBytes);
  hash.update(installedDesktop);
  hash.update(String((await fs.stat(path.join(path.dirname(installedDesktop), "resources", "app.asar"))).mtimeMs));
  const files = [];
  for (const folder of ["src", "bin", "assets", "scripts"]) {
    for (const name of (await fs.readdir(path.join(source, folder))).sort()) {
      const file = path.join(folder, name);
      if (!(await fs.stat(path.join(source, file))).isFile()) continue;
      files.push(file);
      hash.update(file); hash.update(await fs.readFile(path.join(source, file)));
    }
  }
  const root = path.join(home, "native-provider-builds", hash.digest("hex").slice(0, 20));
  const manifest = path.join(root, "native-build.json");
  try { return JSON.parse(await fs.readFile(manifest, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), packageBytes);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  const { prepareProviderLauncher } = await import(pathToFileURL(path.join(root, "src", "provider-launcher.mjs")).href);
  const runtime = await prepareProviderLauncher(installedDesktop, { home: root });
  const desktopBinary = await buildNativeProviderApp(installedDesktop, root);
  await fs.writeFile(path.join(root, "local-build.json"), JSON.stringify({
    desktopBinary, core: path.relative(root, runtime.core), launcher: path.relative(root, runtime.launcher)
  }));
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    path.join(source, "scripts", "build-codexzero-launcher.ps1"), "-BuildRoot", root], { windowsHide: true });
  const result = { ...runtime, desktopBinary, application: path.join(root, "CodexZero.exe") };
  await fs.writeFile(manifest, JSON.stringify(result));
  return result;
}

export async function buildNativeProviderApp(installedDesktop, outputRoot) {
  const installedRoot = path.dirname(installedDesktop);
  const archivePath = path.join(installedRoot, "resources", "app.asar");
  const replacements = await nativeAppReplacements(archivePath, { platform: "win32" });
  const appRoot = path.join(outputRoot, "desktop");
  // Build a separate app copy. Never patch the installed application or executable.
  await fs.cp(installedRoot, appRoot, {
    recursive: true, force: false, errorOnExist: true,
    filter: source => source !== archivePath
  });
  await patchCopiedBrowserService(appRoot);
  await patchCopiedBrowserContinuation(appRoot);
  // The lean desktop is verified against the pinned Windows package.
  if (process.platform === "win32") await pruneCopiedDesktop(appRoot);
  const patchedArchive = path.join(appRoot, "resources", "app.asar");
  await rewriteAsar(archivePath, patchedArchive, replacements);
  await verifyAppArchive(patchedArchive, replacements);
  const executable = path.join(appRoot, path.basename(installedDesktop));
  await updateEmbeddedAsarIntegrity(executable, archivePath, patchedArchive);
  return executable;
}

// The CodexZero changes to the official app archive. Every patch names the one
// script it changes by a literal found in exactly one file, and every anchor
// inside must match exactly once, so a different app version fails instead of
// half patching.
export async function nativeAppReplacements(archivePath, { platform = process.platform } = {}) {
  const lean = platform === "win32";
  const archive = await openAsar(archivePath);
  const assets = path.resolve(import.meta.dirname, "..", "assets");
  const replacements = lean ? await leanChunkReplacements(archive) : new Map();
  const read = async name => (replacements.get(name) ?? await archive.read(name)).toString("utf8");
  try {
    const patches = [
      [SETTINGS_PAGE_TARGET, patchSettingsPage],
      [CACHE_INDICATOR_TARGET, patchCacheIndicator],
      [SELECTION_SCROLL_TARGET, patchSelectionScroll],
      [UPDATER_TARGET, patchNativeUpdater],
      [IDENTITY_TARGET, patchDesktopIdentity],
      [THREAD_VISIBILITY_MAIN_TARGET, patchThreadVisibilityMain],
      [THREAD_VISIBILITY_RENDERER_TARGET, patchThreadVisibilityRenderer],
      [WARM_THREAD_LIMIT_MAIN_TARGET, patchWarmThreadLimitMain],
      [WARM_THREAD_LIMIT_RENDERER_TARGET, patchWarmThreadLimitRenderer],
      [MODEL_REFRESH_TARGET, patchModelRefresh],
      [SIDEBAR_RENDERER_TARGET, patchSidebarRenderer],
      [SIDEBAR_ITEM_INDEX_TARGET, patchSidebarItemIndex],
      [THREAD_PRELOAD_TARGET, patchThreadPreload],
      ...(platform === "win32" ? [[NOTIFICATION_BOOTSTRAP_TARGET, patchNotificationBootstrap], [NOTIFICATION_MAIN_TARGET, patchNotificationMain]] : []),
      ...(lean ? LEAN_FILE_PATCHES : []),
    ];
    const located = await locateTargets(archive, patches.map(([target]) => target));
    for (const [target, patch] of patches) {
      const name = located.get(target);
      replacements.set(name, Buffer.from(patch(await read(name))));
    }
    for (const [name, file] of [
      ["webview/assets/codexzero-provider-settings.js", "native-provider-settings.mjs"],
      ["webview/assets/codexzero-cache-ui.js", "native-cache-ui.mjs"],
      ["webview/assets/codexzero-sidebar-performance.js", "sidebar-performance.mjs"],
      [".vite/build/codexzero-provider-main.cjs", "native-provider-main.cjs"],
      [".vite/build/codexzero-identity.cjs", "native-provider-identity.cjs"],
      [".vite/build/native-sidebar-threads.cjs", "native-sidebar-threads.cjs"],
      [".vite/build/native-provider-updater.cjs", "native-provider-updater.cjs"],
      [".vite/build/native-provider-update-release.cjs", "native-provider-update-release.cjs"],
      ...(platform === "win32" ? [[".vite/build/native-notification-routing.cjs", "native-notification-routing.cjs"]] : []),
      ...(platform === "darwin" ? [[".vite/build/codexzero-environment.cjs", "native-provider-environment.cjs"]] : []),
    ]) replacements.set(name, await fs.readFile(path.join(assets, file)));
    const { version } = JSON.parse(await fs.readFile(path.join(assets, "..", "package.json"), "utf8"));
    replacements.set(".vite/build/codexzero-update-version.json", Buffer.from(JSON.stringify({ version })));
    const environment = platform === "darwin" ? 'require("./codexzero-environment.cjs");' : "";
    replacements.set(".vite/build/early-bootstrap.js", Buffer.concat([Buffer.from(environment + 'require("./codexzero-provider-main.cjs");require("./codexzero-identity.cjs");\n'), await archive.read(".vite/build/early-bootstrap.js")]));
    replacements.set(".vite/build/preload.js", Buffer.concat([await archive.read(".vite/build/preload.js"), Buffer.from("\n"), await fs.readFile(path.join(assets, "native-provider-preload.cjs"))]));
  } finally { await archive.close(); }
  await sidebarIdentityReplacements(archivePath, replacements);
  return replacements;
}

export async function verifyAppArchive(archivePath, replacements) {
  const verify = await openAsar(archivePath);
  try {
    for (const [name, expected] of replacements) {
      if (!(await verify.read(name)).equals(expected)) throw new Error("The native Settings build failed verification");
    }
  } finally { await verify.close(); }
}

// The app registers with Windows and macOS as CodexZero, next to the official app.
export const IDENTITY_TARGET = "r.app.setName((0,g.V)(W))";
export function patchDesktopIdentity(source) {
  for (const [before, after] of [
    ["r.app.setAppUserModelId((0,h.m)(W))", 'r.app.setAppUserModelId("CodexZero.Desktop")'],
    [IDENTITY_TARGET, 'r.app.setName("CodexZero")'],
  ]) {
    if (source.split(before).length !== 2) throw new Error("This Codex version needs an updated desktop identity patch");
    source = source.replace(before, () => after);
  }
  return source;
}

export const UPDATER_TARGET = "j=new H({enableUpdater:";
export function patchNativeUpdater(source) {
  if (source.split(UPDATER_TARGET).length !== 2) throw new Error("This Codex version needs an updated updater patch");
  return source.replace(UPDATER_TARGET, 'j=new(require("./native-provider-updater.cjs").CodexZeroUpdater)({enableUpdater:');
}
