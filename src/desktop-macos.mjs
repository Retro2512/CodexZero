import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { rewriteAsar } from "./asar-patch.mjs";
import { nativeAppReplacements, verifyAppArchive } from "./native-provider-build.mjs";

const run = promisify(execFile);
const OFFICIAL_HOSTS = new Set(["persistent.oaistatic.com", "cdn.openai.com"]);
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
export const APP_NAME = "CodexZero.app";
export const BUNDLE_ID = "com.codexzero.desktop";
const RUNTIME_ITEMS = ["bin", "src", "scripts", "config", "prompts", "package.json"];
const RUNTIME_ASSETS = ["provider-settings.html", "native-provider-settings.mjs", "native-cache-ui.mjs", "model-pricing.mjs",
  "native-provider-main.cjs", "native-provider-preload.cjs", "native-provider-identity.cjs", "native-provider-environment.cjs",
  "native-provider-updater.cjs", "native-provider-update-release.cjs", "native-sidebar-appearance-main.cjs",
  "native-sidebar-identity.mjs", "sidebar-performance.mjs", "transcript-retention.mjs", "codexzero.png"];
// The copy must not claim the original app's links, files, or Dock tile.
const REMOVED_KEYS = ["CFBundleIconName", "CFBundleURLTypes", "CFBundleDocumentTypes", "UTExportedTypeDeclarations",
  "CFBundleAlternateNames", "NSDockTilePlugIn", "SUFeedURL"];
const ICON_SIZES = [[16, "16x16"], [32, "16x16@2x"], [32, "32x32"], [64, "32x32@2x"], [128, "128x128"],
  [256, "128x128@2x"], [256, "256x256"], [512, "256x256@2x"], [512, "512x512"], [1024, "512x512@2x"]];

export async function readMacPin(packageRoot, arch = process.arch) {
  const pin = JSON.parse(await fs.readFile(path.join(packageRoot, "scripts", "desktop-upstream-macos.json"), "utf8"));
  const entry = arch === "arm64" || arch === "x64" ? pin[arch] : null;
  if (!entry) throw new Error("This Mac is not supported.");
  const url = new URL(entry.url);
  if (url.protocol !== "https:" || !OFFICIAL_HOSTS.has(url.hostname)) throw new Error("The desktop package must come from an official HTTPS address.");
  if (!/^\d+\.\d+\.\d+$/.test(pin.version) || !/^[a-z0-9.-]+$/.test(pin.bundleId)) throw new Error("Invalid desktop version.");
  if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error("Invalid desktop checksum.");
  return { version: pin.version, bundleId: pin.bundleId, arch, url: url.href, sha256: entry.sha256, size: entry.size };
}

export function plistCommands({ asarHash }) {
  if (!/^[0-9a-f]{64}$/.test(asarHash)) throw new Error("Invalid app archive hash.");
  return [
    `Set :CFBundleIdentifier ${BUNDLE_ID}`,
    "Set :CFBundleName CodexZero",
    "Set :CFBundleDisplayName CodexZero",
    "Set :CFBundleIconFile codexzero.icns",
    // Chromium keeps its profile and single-instance lock here, apart from the original app.
    "Set :CrProductDirName CodexZero/Browser",
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarHash}`
  ];
}

export function providerLauncherScript() {
  return `#!/bin/sh
# Runs the CodexZero provider router with the runtime inside this bundle.
root="$(cd "$(dirname "$0")/.." && pwd)"
exec "$root/runtime/node" "$root/bin/provider-core.mjs" "$@"
`;
}

export async function asarHeaderHash(file) {
  const handle = await fs.open(file, "r");
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    await handle.read(header, 0, header.length, 16);
    return createHash("sha256").update(header).digest("hex");
  } finally { await handle.close(); }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function matches(file, pin) {
  try { return (await fs.stat(file)).size === pin.size && await sha256File(file) === pin.sha256; }
  catch { return false; }
}

async function plistValue(plist, key) {
  try { return (await run(PLIST_BUDDY, ["-c", `Print :${key}`, plist])).stdout.trim(); }
  catch { return null; }
}

async function installedOriginal(pin) {
  for (const name of ["ChatGPT.app", "Codex.app"]) {
    for (const folder of ["/Applications", path.join(os.homedir(), "Applications")]) {
      const app = path.join(folder, name);
      const plist = path.join(app, "Contents", "Info.plist");
      if (await plistValue(plist, "CFBundleIdentifier") === pin.bundleId &&
          await plistValue(plist, "CFBundleShortVersionString") === pin.version) return app;
    }
  }
  return null;
}

function download(url, destination, progress) {
  // Resume an interrupted download instead of starting again.
  const args = ["--fail", "--location", "--retry", "5", "--retry-delay", "3", "--continue-at", "-", "--output", destination, url];
  const child = spawn("/usr/bin/curl", progress ? ["--progress-bar", ...args] : ["--silent", "--show-error", ...args],
    { stdio: ["ignore", "inherit", "inherit"] });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Could not download Codex desktop. Check your internet connection and try again.")));
  });
}

// Returns the official app to assemble from: the matching installed app, or
// the pinned package from OpenAI's server, verified and kept for later updates.
export async function resolveMacDesktop({ packageRoot, staging, arch = process.arch, skipInstalled = false, progress = false,
  cacheRoot = path.join(os.homedir(), "Library", "Caches", "CodexZero", "desktop") }) {
  const pin = await readMacPin(packageRoot, arch);
  if (!skipInstalled) {
    const installed = await installedOriginal(pin);
    if (installed) return installed;
  }
  await fs.mkdir(cacheRoot, { recursive: true });
  const cached = path.join(cacheRoot, `${pin.version}-${arch}.zip`);
  const partial = `${cached}.partial`;
  if (!(await matches(cached, pin))) {
    await fs.rm(cached, { force: true });
    const current = await fs.stat(partial).then(stat => stat.size, () => 0);
    if (current > pin.size) await fs.rm(partial, { force: true });
    if (current < pin.size) {
      if (progress) console.log("Downloading Codex desktop...");
      await download(pin.url, partial, progress);
    }
    if (!(await matches(partial, pin))) {
      await fs.rm(partial, { force: true });
      throw new Error("The downloaded desktop package failed verification.");
    }
    await fs.rename(partial, cached);
  }
  for (const name of await fs.readdir(cacheRoot)) {
    if (name !== path.basename(cached)) await fs.rm(path.join(cacheRoot, name), { recursive: true, force: true });
  }
  await fs.mkdir(staging, { recursive: true });
  await run("/usr/bin/ditto", ["-x", "-k", cached, staging]);
  const apps = (await fs.readdir(staging)).filter(name => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("Invalid desktop package.");
  const app = path.join(staging, apps[0]);
  const plist = path.join(app, "Contents", "Info.plist");
  if (await plistValue(plist, "CFBundleIdentifier") !== pin.bundleId || await plistValue(plist, "CFBundleShortVersionString") !== pin.version) {
    throw new Error("Invalid desktop package.");
  }
  return app;
}

async function writeIcon(packageRoot, resources) {
  const iconset = path.join(os.tmpdir(), `codexzero-${randomUUID()}.iconset`);
  await fs.mkdir(iconset);
  try {
    const source = path.join(packageRoot, "assets", "codexzero.png");
    for (const [size, name] of ICON_SIZES) {
      await run("/usr/bin/sips", ["-z", String(size), String(size), source, "--out", path.join(iconset, `icon_${name}.png`)]);
    }
    await run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "codexzero.icns")]);
  } finally { await fs.rm(iconset, { recursive: true, force: true }); }
}

// Builds CodexZero.app from an official app. The original is never modified.
export async function assembleMacDesktop({ packageRoot, sourceApp, output }) {
  if (await fs.access(output).then(() => true, () => false)) throw new Error("Build destination already exists.");
  const node = path.join(packageRoot, "runtime", "node");
  await fs.access(node);
  await run("/usr/bin/ditto", [sourceApp, output]);
  const contents = path.join(output, "Contents");
  const resources = path.join(contents, "Resources");
  const sourceArchive = path.join(sourceApp, "Contents", "Resources", "app.asar");
  const replacements = await nativeAppReplacements(sourceArchive, { platform: "darwin" });
  const patched = path.join(resources, `.app.asar.${randomUUID()}`);
  await rewriteAsar(sourceArchive, patched, replacements);
  await verifyAppArchive(patched, replacements);
  await fs.rename(patched, path.join(resources, "app.asar"));

  const root = path.join(resources, "codexzero");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  for (const item of RUNTIME_ITEMS) {
    const source = path.join(packageRoot, item);
    if (await fs.access(source).then(() => true, () => false)) await fs.cp(source, path.join(root, item), { recursive: true });
  }
  for (const asset of RUNTIME_ASSETS) await fs.copyFile(path.join(packageRoot, "assets", asset), path.join(root, "assets", asset));
  await fs.mkdir(path.join(root, "runtime"));
  await fs.copyFile(node, path.join(root, "runtime", "node"));
  await fs.chmod(path.join(root, "runtime", "node"), 0o755);
  await fs.mkdir(path.join(root, "provider-runtime"));
  await fs.writeFile(path.join(root, "provider-runtime", "codex-custom-models"), providerLauncherScript(), { mode: 0o755 });
  await writeIcon(packageRoot, resources);

  const plist = path.join(contents, "Info.plist");
  await run(PLIST_BUDDY, [...plistCommands({ asarHash: await asarHeaderHash(path.join(resources, "app.asar")) }).flatMap(command => ["-c", command]), plist]);
  for (const key of REMOVED_KEYS) await run(PLIST_BUDDY, ["-c", `Delete :${key}`, plist]).catch(() => {});
  // The original profile grants the original signer's entitlements only.
  await fs.rm(path.join(contents, "embedded.provisionprofile"), { force: true });
  await run("/usr/bin/xattr", ["-cr", output]);
  await run("/usr/bin/codesign", ["--force", "--sign", "-", output]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", output]);
  return output;
}

export async function buildMacDesktop({ packageRoot, output, skipInstalled = false, progress = false, cacheRoot }) {
  const staging = path.join(os.tmpdir(), `codexzero-desktop-${randomUUID()}`);
  try {
    const sourceApp = await resolveMacDesktop({ packageRoot, staging, skipInstalled, progress, cacheRoot });
    if (progress) console.log("Setting up CodexZero...");
    return await assembleMacDesktop({ packageRoot, sourceApp, output });
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function isRunning(app) {
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "command="], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\n").some(line => line.trim().startsWith(path.join(app, "Contents") + path.sep));
  } catch { return false; }
}

export async function installMacDesktop({ packageRoot, applications = path.join(os.homedir(), "Applications"), open = true,
  skipInstalled = false, progress = true, cacheRoot }) {
  const target = path.join(applications, APP_NAME);
  if (await isRunning(target)) throw new Error("Quit CodexZero before continuing.");
  await fs.mkdir(applications, { recursive: true });
  // Build beside the destination so the final switch is a rename.
  const build = path.join(applications, `.CodexZero-${randomUUID()}.app`);
  await buildMacDesktop({ packageRoot, output: build, skipInstalled, progress, cacheRoot });
  const previous = path.join(applications, `.CodexZero-previous-${randomUUID()}.app`);
  const replacing = await fs.access(target).then(() => true, () => false);
  if (replacing) await fs.rename(target, previous);
  try { await fs.rename(build, target); }
  catch (error) {
    if (replacing) await fs.rename(previous, target);
    await fs.rm(build, { recursive: true, force: true });
    throw error;
  }
  if (replacing) await fs.rm(previous, { recursive: true, force: true });
  await run(LSREGISTER, ["-f", target]).catch(() => {});
  if (open) await run("/usr/bin/open", [target]);
  return target;
}
