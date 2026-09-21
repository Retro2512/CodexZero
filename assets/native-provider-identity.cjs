"use strict";
const { app } = require("electron");
const path = require("node:path");
const APP_ID = "CodexZero.Desktop";
const root = path.resolve(process.resourcesPath, "..", "..");
const icon = path.join(root, "assets", "codexzero.ico");
const launcher = path.join(root, "CodexZero.exe");

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
