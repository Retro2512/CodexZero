import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { checkForCoreUpdate, selectUpdatedCore, launchCoreUpdateWorker, verifyOfficialCoreSignature } from "../src/core-updates.mjs";

test("signature checks use system PowerShell and its own modules", async () => {
  let command;
  assert.equal(await verifyOfficialCoreSignature("example.exe", {
    environment: { SystemRoot: "C:\\Windows", PSModulePath: "incompatible PowerShell 7 modules" },
    execute: async (...args) => { command = args; return { stdout: "VALID\r\n" }; },
  }), true);
  assert.equal(command[0], path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.equal(command[2].env.PSModulePath, path.join(path.dirname(command[0]), "Modules"));
  assert.equal(command[2].windowsHide, true);
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-core-update-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fallback = path.join(root, "bundled.exe");
  const stockRoot = path.join(root, "stock");
  const home = path.join(root, "cache-home");
  await fs.mkdir(stockRoot);
  await fs.writeFile(fallback, "0.155.0");
  async function stock(id, value, companions = ["codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]) {
    const dir = path.join(stockRoot, id);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "codex.exe"), value);
    for (const name of companions) await fs.writeFile(path.join(dir, name), `signed ${name}`);
    return dir;
  }
  const probes = [];
  const options = {
    platform: "win32", home, stockRoot,
    verifySignature: async file => !(await fs.readFile(file, "utf8")).includes("unsigned"),
    readVersion: async file => `codex-cli ${(await fs.readFile(file, "utf8")).match(/\d+\.\d+\.\d+(?:-[\w.]+)?/)?.[0] || "invalid"}`,
    prepareCore: async source => {
      const target = path.join(path.dirname(source), "codex-provider-context.exe");
      await fs.copyFile(source, target);
      return target;
    },
    verifyCoreCompatibility: async (candidate, details) => { probes.push({ candidate, ...details }); }
  };
  return { root, home, stockRoot, fallback, stock, options, probes };
}

test("stages a verified update and selects only its unchanged prepared core", async t => {
  const f = await fixture(t);
  const dir = await f.stock("aabbccdd", "0.159.2");
  const result = await checkForCoreUpdate(f.fallback, f.options);
  assert.equal(result.status, "updated");
  assert.equal(selectUpdatedCore(f.fallback, f.options), result.core);
  assert.equal(path.basename(result.core), "codex-provider-context.exe");
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].baseline, f.fallback);
  assert.equal(await fs.readFile(path.join(dir, "codex.exe"), "utf8"), "0.159.2");
  assert.equal((await checkForCoreUpdate(f.fallback, f.options)).status, "throttled");
  await fs.appendFile(result.core, "tampered");
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
});

test("rejects unsigned, older, and incompatible candidates without rollback", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.154.0");
  await f.stock("bbccddee", "unsigned 0.160.0");
  assert.equal((await checkForCoreUpdate(f.fallback, f.options)).status, "checked");
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
  const dir = await f.stock("ccddeeaa", "0.159.2");
  f.options.verifyCoreCompatibility = async () => { throw new Error("incompatible"); };
  assert.equal((await checkForCoreUpdate(f.fallback, { ...f.options, force: true })).status, "checked");
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
  assert.deepEqual(await fs.readdir(path.join(f.home, "cache")), []);
  f.options.verifyCoreCompatibility = async () => {};
  const result = await checkForCoreUpdate(f.fallback, { ...f.options, force: true });
  assert.equal(result.status, "updated");
  await fs.writeFile(path.join(dir, "codex.exe"), "0.154.0");
  assert.equal((await checkForCoreUpdate(f.fallback, { ...f.options, force: true })).status, "checked");
  assert.equal(selectUpdatedCore(f.fallback, f.options), result.core);
});

test("does not accept a signed stock extraction missing a mandatory companion", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.159.2", ["codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]);
  assert.equal((await checkForCoreUpdate(f.fallback, f.options)).status, "checked");
  assert.equal(f.probes.length, 0);
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
  assert.deepEqual((await fs.readdir(f.home)).filter(name => name.startsWith("stage-")), []);
});

test("fallback identity, manifest paths and companion stats fail closed", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.159.2");
  const result = await checkForCoreUpdate(f.fallback, f.options);
  assert.equal(selectUpdatedCore(f.fallback, { ...f.options, releaseId: "other" }), f.fallback);
  const stateFile = path.join(f.home, "state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const companion = path.join(f.home, "cache", state.active.id, "codex-command-runner.exe");
  await fs.appendFile(companion, "x");
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
  await fs.writeFile(stateFile, JSON.stringify({ ...state, active: { ...state.active, id: "../escape" } }));
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
  assert.notEqual(result.core, f.fallback);
});

test("a live lock serializes checks and failed preparation leaves no active entry", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.159.2");
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.options.verifyCoreCompatibility = async () => { entered(); await held; };
  const first = checkForCoreUpdate(f.fallback, f.options);
  await started;
  assert.equal((await checkForCoreUpdate(f.fallback, f.options)).status, "busy");
  release();
  assert.equal((await first).status, "updated");
  const state = JSON.parse(await fs.readFile(path.join(f.home, "state.json"), "utf8"));
  await fs.rm(path.join(f.home, "state.json"));
  f.options.prepareCore = async () => { throw new Error("unknown patch"); };
  assert.equal((await checkForCoreUpdate(f.fallback, { ...f.options, force: true })).status, "checked");
  assert.equal(selectUpdatedCore(f.fallback, f.options), f.fallback);
  assert.ok(state.active);
  assert.deepEqual((await fs.readdir(f.home)).filter(name => name.startsWith("stage-")), []);
});

test("retains the previous known good core when the newest cache is damaged", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.159.2");
  const first = await checkForCoreUpdate(f.fallback, f.options);
  await f.stock("bbccddee", "0.160.0");
  const second = await checkForCoreUpdate(f.fallback, { ...f.options, force: true });
  assert.equal(second.status, "updated");
  assert.equal(f.probes.at(-1).baseline, first.core);
  await fs.appendFile(second.core, "damage");
  assert.equal(selectUpdatedCore(f.fallback, f.options), first.core);
});

test("concurrent recovery of a dead worker lock admits one checker", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.159.2");
  await fs.mkdir(f.home);
  await fs.writeFile(path.join(f.home, "worker.lock"), JSON.stringify({ pid: 2147483647, token: "dead" }));
  let calls = 0;
  f.options.verifyCoreCompatibility = async () => { calls++; };
  const results = await Promise.all([
    checkForCoreUpdate(f.fallback, f.options),
    checkForCoreUpdate(f.fallback, f.options)
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), ["busy", "updated"]);
  assert.equal(calls, 1);
});

test("interrupted lock writes recover only after the writer grace period", async t => {
  const f = await fixture(t);
  await f.stock("aabbccdd", "0.159.2");
  await fs.mkdir(f.home);
  const lock = path.join(f.home, "worker.lock");
  await fs.writeFile(lock, "{");
  assert.equal((await checkForCoreUpdate(f.fallback, f.options)).status, "busy");
  const past = new Date(Date.now() - 120_000);
  await fs.utimes(lock, past, past);
  assert.equal((await checkForCoreUpdate(f.fallback, f.options)).status, "updated");
});

test("non Windows selection and checks leave stock untouched", async t => {
  const f = await fixture(t);
  assert.equal(selectUpdatedCore(f.fallback, { ...f.options, platform: "darwin" }), f.fallback);
  assert.equal((await checkForCoreUpdate(f.fallback, { ...f.options, platform: "darwin" })).status, "unsupported");
  const off = { ...f.options, environment: { CODEX_ZERO_CORE_UPDATES: "0" } };
  assert.equal(selectUpdatedCore(f.fallback, off), f.fallback);
  assert.equal((await checkForCoreUpdate(f.fallback, off)).status, "unsupported");
  assert.equal(launchCoreUpdateWorker(f.fallback, off), null);
});

test("detached worker finishes after its launching process exits", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const workerHome = path.join(f.root, "worker-home");
  const moduleUrl = pathToFileURL(path.resolve("src/core-updates.mjs")).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(m => m.launchCoreUpdateWorker(process.execPath))`;
  const parent = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, CODEX_ZERO_HOME: workerHome, LOCALAPPDATA: path.join(f.root, "empty-appdata") },
    stdio: "ignore", windowsHide: true
  });
  await new Promise((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", code => code === 0 ? resolve() : reject(new Error(`launcher exited ${code}`)));
  });
  const stateFile = path.join(workerHome, "core-updates", "state.json");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      assert.ok(Number.isFinite(state.checkedAt));
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.fail("detached worker did not write checked state");
});
