"use strict";
const { app } = require("electron");
const path = require("node:path");
const APP_ID = "CodexZero.Desktop";
const mac = process.platform === "darwin";
const root = mac ? path.join(process.resourcesPath, "codexzero") : path.resolve(process.resourcesPath, "..", "..");
const icon = path.join(root, "assets", mac ? "codexzero.png" : "codexzero.ico");
const launcher = path.join(process.env.CODEX_ZERO_LAUNCH_ROOT || root, "CodexZero.exe");

if (process.platform === "win32") {
  // Keep the official codex:// association untouched. Use the stable launcher
  // so notification activation also survives an application update.
  app.whenReady().then(() => {
    if (!app.setAsDefaultProtocolClient("codexzero", launcher, [])) {
      console.error("CodexZero notification protocol registration failed");
    }
  }).catch(error => console.error("CodexZero notification protocol registration failed", error));
}

app.on("browser-window-created", (_event, window) => {
  window.setIcon?.(icon);
  window.setTitle("CodexZero");
  window.setAppDetails?.({
    appId: APP_ID,
    appIconPath: icon,
    appIconIndex: 0,
    relaunchCommand: `"${launcher}"`,
    relaunchDisplayName: "CodexZero"
  });
  window.on("page-title-updated", event => {
    event.preventDefault();
    window.setTitle("CodexZero");
  });
});

// The Dock follows the app's own icon preference. Keep the CodexZero mark.
if (mac && app.dock) {
  const setDockIcon = app.dock.setIcon.bind(app.dock);
  app.dock.setIcon = () => setDockIcon(icon);
  app.whenReady().then(() => setDockIcon(icon)).catch(() => {});
}
