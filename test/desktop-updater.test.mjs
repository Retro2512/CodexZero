import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { patchNativeUpdater } from "../src/native-provider-build.mjs";
const require = createRequire(import.meta.url);
const { CodexZeroUpdater } = require("../assets/native-provider-updater.cjs");
const release = {
  tag_name: "v0.8.0", draft: false, prerelease: false,
  assets: ["codex-zero-desktop-windows-x64.zip", "codex-zero-desktop-windows-x64.zip.sha256"].map(name => ({
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
  }, { electron, version: "0.7.1", fetch: async () => ({ ok: true, json: async () => release }),
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
