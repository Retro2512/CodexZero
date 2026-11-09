"use strict";
const { app, ipcMain } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
// Windows builds keep CodexZero beside the app. macOS keeps it inside the bundle.
const root = process.platform === "darwin" ? path.join(process.resourcesPath, "codexzero") : path.resolve(process.resourcesPath, "..", "..");

// The local build uses exactly the existing trusted main renderer boundary.
function trusted(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === "app:" && url.hostname === "-";
  } catch { return false; }
}
let service;
function configService() {
  return service ??= import(pathToFileURL(path.join(root, "src", "provider-config-service.mjs")).href);
}
ipcMain.handle("codexzero:providers:read", async event => {
  if (!trusted(event)) throw new Error("Provider settings are unavailable here");
  try { return await (await configService()).readProviderSettings(); }
  catch { throw new Error("Unable to load provider settings"); }
});
ipcMain.handle("codexzero:providers:save", async (event, document) => {
  if (!trusted(event)) throw new Error("Provider settings are unavailable here");
  if (JSON.stringify(document)?.length > 256 * 1024) throw new Error("Provider settings are too large");
  try { return await (await configService()).saveProviderSettings(document); }
  catch (error) { throw new Error(error instanceof TypeError ? error.message : "Unable to save provider settings"); }
});

let cacheService;
function cache() {
  return cacheService ??= import(pathToFileURL(path.join(root, "src", "cache-service-client.mjs")).href)
    .then(({ createCacheServiceClient }) => createCacheServiceClient());
}
app.once?.("before-quit", event => {
  if (!cacheService) return;
  event.preventDefault();
  void cacheService.then(client => client.close()).catch(() => {}).finally(() => app.quit());
});
for (const [operation, method] of Object.entries({ read: "readCacheSnapshot", settings: "saveCacheSettings", enabled: "setCacheEnabled", activity: "cacheActivity" })) {
  ipcMain.handle(`codexzero:cache:${operation}`, async (event, ...args) => {
    if (!trusted(event)) throw new Error("Cache settings are unavailable here");
    if (args.length !== (operation === "enabled" ? 2 : 1)) throw new Error("Invalid cache settings");
    if (JSON.stringify(args).length > 4096) throw new Error("Invalid cache settings");
    try { return await (await cache())[method](...args); }
    catch (error) { throw new Error(error instanceof TypeError ? error.message : "Could not update context cache"); }
  });
}

// Optional ChatGPT surfaces. Read once at startup so every patched check in the
// app sees the same answer; changes apply after a restart.
const fs = require("node:fs");
const os = require("node:os");
const featuresFile = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codexzero", "app-features.json");
function readFeatures() {
  try {
    const value = JSON.parse(fs.readFileSync(featuresFile, "utf8"));
    return { workMode: value?.workMode === true, chats: value?.chats === true, dots: value?.dots === true };
  } catch { return { workMode: false, chats: false, dots: false }; }
}
globalThis.czAppFeatures = readFeatures();
ipcMain.on("codexzero:features:current", event => {
  event.returnValue = trusted(event) ? { ...globalThis.czAppFeatures, available: globalThis.czLeanApp === true } : null;
});
ipcMain.handle("codexzero:features:save", async (event, value) => {
  if (!trusted(event)) throw new Error("Settings are unavailable here");
  const next = { workMode: value?.workMode === true, chats: value?.chats === true, dots: value?.dots === true };
  await fs.promises.mkdir(path.dirname(featuresFile), { recursive: true });
  const temporary = `${featuresFile}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(next, null, 2) + "\n");
  await fs.promises.rename(temporary, featuresFile);
  return next;
});
// Windows reopens through the CodexZero launcher once this process has fully
// exited, the same way updates hand off, so the new window is never refused.
function reopenAfterExit() {
  const launchRoot = path.resolve(process.env.CODEX_ZERO_LAUNCH_ROOT || path.resolve(process.resourcesPath, "..", ".."));
  const launcher = path.join(launchRoot, "CodexZero.exe");
  const script = `Wait-Process -Id ${Number(process.pid)} -Timeout 120 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-Process -FilePath '${launcher.replace(/'/g, "''")}'`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => require("node:child_process").execFile(powershell,
    ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -WindowStyle Hidden -FilePath '${powershell.replace(/'/g, "''")}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'`],
    { windowsHide: true, timeout: 30000 }, error => error ? reject(error) : resolve()));
}
ipcMain.handle("codexzero:app:restart", async event => {
  if (!trusted(event)) throw new Error("Restart is unavailable here");
  if (process.platform === "win32") await reopenAfterExit();
  else app.relaunch();
  app.quit();
});

// Isolated GUI verification never touches the normal app profile.
if (process.env.CODEX_ZERO_NATIVE_TEST_PROFILE) app.setPath("userData", process.env.CODEX_ZERO_NATIVE_TEST_PROFILE);
