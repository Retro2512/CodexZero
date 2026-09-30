import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patchNativeUpdater } from "../src/native-provider-build.mjs";
const require = createRequire(import.meta.url);
const { CodexZeroUpdater, waitForHandoff } = require("../assets/native-provider-updater.cjs");
const release = {
  tag_name: "v0.8.0", draft: false, prerelease: false,
  assets: ["codex-zero-windows-x64.zip", "codex-zero-windows-x64.zip.sha256"].map(name => ({
    name, browser_download_url: `https://github.com/Retro2512/CodexZero/releases/download/v0.8.0/${name}`
  }))
};
function fixture(overrides = {}) {
  const events = [];
  const electron = {
    app: { quit: () => events.push("quit"), once() {} },
    ipcMain: { handle: (channel, callback) => events.push({ channel, callback }) },
    dialog: { showMessageBox: async () => events.push("error") }
  };
  const updater = new CodexZeroUpdater({
    isTrustedIpcEvent: event => event.trusted === true,
    onUpdateReadyChanged: ready => events.push({ ready }),
    onUpdateLifecycleStateChanged: state => events.push(state),
    onInstallUpdatesRequested: () => events.push("nativeQuit")
  }, { electron, failurePath: null, version: "0.7.1", archive: "codex-zero-windows-x64.zip", fetch: async () => ({ ok: true, json: async () => release }),
    prepare: async () => events.push("prepared"), ...overrides });
  updater.hasUpdater = () => true;
  return { updater, events };
}
test("native updater patch replaces only the updater instance and fails on drift", () => {
  const source = "before,sparkleManager:new KT({enableUpdater:yes}),after";
  const patched = patchNativeUpdater(source);
  assert.match(patched, /CodexZeroUpdater/);
  assert.ok(patched.endsWith("({enableUpdater:yes}),after"));
  assert.throws(() => patchNativeUpdater("different version"));
  assert.throws(() => patchNativeUpdater(source + source));
});
test("release discovery exposes native download icon state without installing", async () => {
  const { updater, events } = fixture();
  await updater.checkForUpdates();
  assert.equal(updater.getIsUpdateReady(), true);
  assert.equal(updater.getUpdateLifecycleState(), "ready");
  assert.equal(updater.getSupportsAutoInstallWhenIdle(), false);
  assert.ok(!events.includes("prepared"));
});
test("click prepares the update before native quit; duplicate clicks share work", async () => {
  const { updater, events } = fixture();
  await updater.checkForUpdates();
  const first = updater.installUpdatesIfAvailable();
  assert.equal(first, updater.installUpdatesIfAvailable());
  assert.equal(await first, true);
  assert.ok(events.indexOf("prepared") < events.indexOf("nativeQuit"));
  assert.equal(events.filter(e => e === "prepared").length, 1);
});
test("failed preparation leaves the app running with a retry action", async () => {
  const { updater, events } = fixture({ prepare: async () => { throw Error("bad checksum"); } });
  await updater.checkForUpdates();
  assert.equal(await updater.installUpdatesIfAvailable(), false);
  assert.equal(updater.getIsUpdateReady(), true);
  assert.ok(events.includes("error"));
  assert.ok(!events.includes("nativeQuit"));
});
test("offline checks retain an available update and do not interrupt work", async () => {
  const { updater, events } = fixture();
  await updater.checkForUpdates();
  updater.fetch = async () => { throw Error("offline"); };
  await updater.checkForUpdates();
  assert.equal(updater.getIsUpdateReady(), true);
  assert.ok(!events.includes("error"));
});
test("same or older releases leave the native indicator hidden", async () => {
  const { updater } = fixture({ version: "0.9.0" });
  await updater.checkForUpdates();
  assert.equal(updater.getIsUpdateReady(), false);
});
test("native IPC check respects trusted renderer boundary", async () => {
  const { updater, events } = fixture();
  await updater.initialize();
  await updater.busy;
  clearInterval(updater.timer);
  let checks = 0;
  updater.checkForUpdates = () => { checks++; };
  const { callback } = events.find(e => e?.channel);
  await callback({ trusted: false });
  assert.equal(checks, 0);
  await callback({ trusted: true });
  assert.equal(checks, 1);
});

test("a prepared update cannot start a second helper while quit is pending", async () => {
  const { updater, events } = fixture();
  await updater.checkForUpdates();
  assert.equal(await updater.installUpdatesIfAvailable(), true);
  await updater.checkForUpdates();
  assert.equal(await updater.installUpdatesIfAvailable(), false);
  assert.equal(events.filter(event => event === "prepared").length, 1);
});

test("a rejected async quit cancels its helper and keeps the retry available", async () => {
  let cancelled = false;
  const { updater, events } = fixture({ prepare: async () => () => { cancelled = true; } });
  updater.options.onInstallUpdatesRequested = async () => { throw new Error("quit rejected"); };
  await updater.checkForUpdates();
  assert.equal(await updater.installUpdatesIfAvailable(), false);
  assert.equal(cancelled, true);
  assert.equal(updater.handingOff, false);
  assert.equal(updater.getIsUpdateReady(), true);
  assert.ok(events.includes("error"));
});

test("a helper cancellation error does not hide the update failure or disable retry", async () => {
  const { updater, events } = fixture({ prepare: async () => async () => { throw Error("helper stopped"); } });
  updater.options.onInstallUpdatesRequested = async () => { throw Error("quit rejected"); };
  await updater.checkForUpdates();
  assert.equal(await updater.installUpdatesIfAvailable(), false);
  assert.equal(updater.handingOff, false);
  assert.equal(updater.getIsUpdateReady(), true);
  assert.ok(events.includes("error"));
});

test("update failure stays saved until its dialog is acknowledged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-update-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const failurePath = path.join(root, "update-failed.txt");
  await fs.writeFile(failurePath, "CodexZero update failed.");
  const { updater } = fixture({ failurePath });
  updater.electron.app.whenReady = async () => {};
  let acknowledge;
  let displayed;
  const shown = new Promise(resolve => { displayed = resolve; });
  updater.electron.dialog.showMessageBox = () => {
    displayed();
    return new Promise(resolve => { acknowledge = resolve; });
  };
  const result = updater.showPreviousFailure();
  await shown;
  assert.equal(await fs.readFile(failurePath, "utf8"), "CodexZero update failed.");
  acknowledge();
  await result;
  await assert.rejects(fs.access(failurePath));
  await fs.writeFile(failurePath, "another failure");
  updater.electron.dialog.showMessageBox = async () => { throw Error("app closed"); };
  await updater.showPreviousFailure();
  assert.equal(await fs.readFile(failurePath, "utf8"), "another failure");
});

test("handoff readiness requires a live helper and an explicit acknowledgement", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-update-ready-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ready = path.join(root, "ready.txt");
  const child = { exitCode: null, signalCode: null };
  await assert.rejects(waitForHandoff(child, ready, { timeout: 100 }), /did not become ready/);
  await fs.writeFile(ready, "ready");
  await waitForHandoff(child, ready);
  await assert.rejects(waitForHandoff({ exitCode: 1, signalCode: null }, ready), /stopped/);
});
