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

// Isolated GUI verification never touches the normal app profile.
if (process.env.CODEX_ZERO_NATIVE_TEST_PROFILE) app.setPath("userData", process.env.CODEX_ZERO_NATIVE_TEST_PROFILE);
