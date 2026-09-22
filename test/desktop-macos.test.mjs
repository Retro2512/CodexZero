import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { asarHeaderHash, plistCommands, providerLauncherScript, readMacPin } from "../src/desktop-macos.mjs";

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");
const posix = process.platform !== "win32";
const pinned = JSON.parse(await fs.readFile(path.join(repository, "scripts/desktop-upstream-macos.json"), "utf8"));

async function temporary(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function packageWithPin(t, pin) {
  const root = await temporary(t, "cz-mac-pin-");
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "scripts/desktop-upstream-macos.json"), JSON.stringify(pin));
  return root;
}

test("Mac desktop is pinned to official versioned packages for both chips", async () => {
  for (const arch of ["arm64", "x64"]) {
    const pin = await readMacPin(repository, arch);
    assert.equal(pin.version, pinned.version);
    assert.equal(pin.url, `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-${arch}-${pinned.version}.zip`);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
    assert.ok(pin.size > 100 * 1024 ** 2);
  }
  await assert.rejects(readMacPin(repository, "ia32"), /not supported/);
});

test("Mac desktop pin rejects unofficial or malformed packages", async t => {
  const entry = pinned.arm64;
  for (const [change, message] of [
    [{ arm64: { ...entry, url: "https://example.com/ChatGPT.zip" } }, /official HTTPS address/],
    [{ arm64: { ...entry, url: entry.url.replace("https:", "http:") } }, /official HTTPS address/],
    [{ arm64: { ...entry, sha256: "0".repeat(63) } }, /Invalid desktop checksum/],
    [{ arm64: { ...entry, size: 0 } }, /Invalid desktop checksum/],
    [{ version: "latest" }, /Invalid desktop version/]
  ]) {
    await assert.rejects(readMacPin(await packageWithPin(t, { ...pinned, ...change }), "arm64"), message);
  }
});

test("Mac bundle identity separates CodexZero from the original app", () => {
  const hash = "a".repeat(64);
  const commands = plistCommands({ asarHash: hash });
  assert.ok(commands.includes("Set :CFBundleIdentifier com.codexzero.desktop"));
  assert.ok(commands.includes("Set :CrProductDirName CodexZero/Browser"));
  assert.ok(commands.includes(`Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`));
  assert.throws(() => plistCommands({ asarHash: "not a hash" }), /Invalid app archive hash/);
});

test("app archive integrity hash covers exactly the archive header", async t => {
  const dir = await temporary(t, "cz-asar-");
  const header = Buffer.from('{"files":{"a.js":{"size":1,"offset":"0"}}}');
  const archive = Buffer.alloc(16 + header.length + 1);
  archive.writeUInt32LE(4, 0);
  archive.writeUInt32LE(header.length + 8, 4);
  archive.writeUInt32LE(header.length + 4, 8);
  archive.writeUInt32LE(header.length, 12);
  header.copy(archive, 16);
  await fs.writeFile(path.join(dir, "app.asar"), archive);
  assert.equal(await asarHeaderHash(path.join(dir, "app.asar")), createHash("sha256").update(header).digest("hex"));
});

test("provider launcher runs the bundled runtime from any location", { skip: !posix }, async t => {
  const dir = await temporary(t, "cz-mac-launcher-");
  const root = path.join(dir, "Moved App.app/Contents/Resources/codexzero");
  await fs.mkdir(path.join(root, "runtime"), { recursive: true });
  await fs.mkdir(path.join(root, "bin"));
  await fs.mkdir(path.join(root, "provider-runtime"));
  await fs.symlink(process.execPath, path.join(root, "runtime/node"));
  await fs.writeFile(path.join(root, "bin/provider-core.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));");
  const launcher = path.join(root, "provider-runtime/codex-custom-models");
  await fs.writeFile(launcher, providerLauncherScript(), { mode: 0o755 });
  const { stdout } = await run(launcher, ["app-server", "argument with spaces"]);
  assert.deepEqual(JSON.parse(stdout), ["app-server", "argument with spaces"]);
});

async function handoffFixture(t) {
  const dir = await temporary(t, "cz-mac-handoff-");
  const bundle = path.join(dir, "Applications/CodexZero.app");
  const stage = path.join(dir, "Caches/updates/.stage-1");
  const build = path.join(stage, "CodexZero.app");
  await fs.mkdir(bundle, { recursive: true });
  await fs.mkdir(build, { recursive: true });
  await fs.writeFile(path.join(bundle, "marker"), "old");
  await fs.writeFile(path.join(build, "marker"), "new");
  await fs.copyFile(path.join(repository, "scripts/complete-desktop-update-macos.sh"), path.join(stage, "complete.sh"));
  await fs.mkdir(path.join(dir, "bin"));
  await fs.writeFile(path.join(dir, "bin/open"), `#!/bin/sh\necho "$1" > "${path.join(dir, "opened")}"\n`, { mode: 0o755 });
  return { dir, bundle, stage, build };
}

function handoff(f) {
  const parent = spawn("sleep", ["1"]);
  const child = spawn("sh", [path.join(f.stage, "complete.sh"), f.bundle, f.build, String(parent.pid)], {
    env: { ...process.env, HOME: f.dir, PATH: `${path.join(f.dir, "bin")}:${process.env.PATH}` }, stdio: "ignore"
  });
  return new Promise(resolve => child.once("exit", resolve));
}

test("Mac update switches the app only after it quits, then reopens it", { skip: !posix }, async t => {
  const f = await handoffFixture(t);
  assert.equal(await handoff(f), 0);
  assert.equal(await fs.readFile(path.join(f.bundle, "marker"), "utf8"), "new");
  assert.deepEqual((await fs.readdir(path.dirname(f.bundle))).sort(), ["CodexZero.app"]);
  assert.equal((await fs.readFile(path.join(f.dir, "opened"), "utf8")).trim(), f.bundle);
  await assert.rejects(fs.access(f.stage));
});

test("Mac update keeps the current app when the new one cannot be switched in", { skip: !posix }, async t => {
  const f = await handoffFixture(t);
  await fs.rm(f.build, { recursive: true });
  await handoff(f);
  assert.equal(await fs.readFile(path.join(f.bundle, "marker"), "utf8"), "old");
  assert.deepEqual(await fs.readdir(path.dirname(f.bundle)), ["CodexZero.app"]);
  assert.match(await fs.readFile(path.join(f.dir, "Library/Caches/CodexZero/update-failed.txt"), "utf8"), /update failed/);
});

test("Mac update never swaps paths outside a staged CodexZero build", { skip: !posix }, async t => {
  const f = await handoffFixture(t);
  const unexpected = path.join(f.dir, "Elsewhere/CodexZero.app");
  await fs.mkdir(unexpected, { recursive: true });
  assert.notEqual(await handoff({ ...f, build: unexpected }), 0);
  assert.equal(await fs.readFile(path.join(f.bundle, "marker"), "utf8"), "old");
});

test("Mac environment reuses the Codex home with a separate browser profile", { skip: process.platform !== "darwin" }, async t => {
  const dir = await temporary(t, "cz-mac-env-");
  const script = `process.resourcesPath = ${JSON.stringify(path.join(dir, "CodexZero.app/Contents/Resources"))};
require(${JSON.stringify(path.join(repository, "assets/native-provider-environment.cjs"))});
const keys = ["CODEX_ZERO_DESKTOP", "CODEX_CLI_PATH", "CODEX_APP_SERVER_FORCE_CLI", "CODEX_ZERO_PROVIDER_CORE", "CODEX_ZERO_LAUNCH_ROOT", "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_SQLITE_HOME"];
console.log(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))));`;
  const env = { ...process.env, HOME: dir, CODEX_SQLITE_HOME: path.join(dir, ".codex/codexzero/sqlite") };
  for (const key of ["CODEX_ZERO_DESKTOP", "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_ZERO_HOME", "CODEX_ZERO_SQLITE_HOME"]) delete env[key];
  const { stdout } = await run(process.execPath, ["-e", script], { env });
  const result = JSON.parse(stdout);
  const resources = path.join(dir, "CodexZero.app/Contents/Resources");
  assert.equal(result.CODEX_ZERO_DESKTOP, "1");
  assert.equal(result.CODEX_CLI_PATH, path.join(resources, "codexzero/provider-runtime/codex-custom-models"));
  assert.equal(result.CODEX_ZERO_PROVIDER_CORE, path.join(resources, "codex"));
  assert.equal(result.CODEX_ZERO_LAUNCH_ROOT, path.join(dir, "CodexZero.app"));
  assert.equal(result.CODEX_HOME, path.join(dir, ".codex"));
  assert.equal(result.CODEX_ELECTRON_USER_DATA_PATH, path.join(dir, "Library/Application Support/CodexZero/Browser"));
  assert.equal(result.CODEX_SQLITE_HOME, null);
});

test("Mac one-line install sets up the app and keeps the terminal install available", async () => {
  const bootstrap = await fs.readFile(path.join(repository, "scripts/bootstrap.sh"), "utf8");
  assert.match(bootstrap, /CODEX_ZERO_INSTALL:-app\}" != "cli"/);
  assert.match(bootstrap, /-f "\$TEMP\/scripts\/install-desktop-macos\.sh"/);
  assert.match(bootstrap, /sw_vers -productVersion \| cut -d\. -f1\)" -ge 13/);
  const workflow = await fs.readFile(path.join(repository, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /install-desktop-macos\.sh "\$PWD\/package" --applications "\$apps" --no-open --skip-installed/);
  assert.match(workflow, /verify-desktop-macos\.mjs "\$apps\/CodexZero\.app"/);
});
