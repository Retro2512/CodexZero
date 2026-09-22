import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DESKTOP_ASSETS = Object.freeze([
  "assets/provider-settings.html", "assets/native-provider-settings.mjs",
  "assets/native-provider-main.cjs", "assets/native-provider-preload.cjs",
  "assets/native-provider-identity.cjs", "assets/native-cache-ui.mjs",
  "assets/model-pricing.mjs", "assets/codexzero.ico", "assets/codexzero.png",
  "bin/provider-core.mjs", "bin/local-provider-app.mjs",
  "scripts/build-codexzero-launcher.ps1", "scripts/build-provider-local.ps1",
  "assets/native-provider-updater.cjs", "assets/native-provider-update-release.cjs",
  "scripts/complete-desktop-update.ps1",
  "scripts/install-desktop.ps1", "scripts/uninstall-desktop.ps1",
  "scripts/build-desktop-release.ps1", "scripts/build-desktop-setup.ps1",
  "scripts/windows-desktop.iss", "scripts/verify-complete-desktop.mjs",
  "src/desktop-profile.mjs",
]);

export async function verifyDesktopAssets(root) {
  for (const relative of DESKTOP_ASSETS) {
    const stat = await fs.stat(path.join(root, relative));
    if (!stat.isFile() || !stat.size) throw new Error(`Missing Desktop asset: ${relative}`);
  }
  // Load the dependency graph without starting a server or making model calls.
  for (const relative of ["src/provider-app-server.mjs", "src/native-provider-build.mjs", "src/cache-service.mjs", "assets/native-cache-ui.mjs"]) {
    await import(pathToFileURL(path.resolve(root, relative)).href);
  }
}

const canonical = value => process.platform === "win32" ? value.toLowerCase() : value;
if (process.argv[1] && canonical(pathToFileURL(await fs.realpath(new URL(import.meta.url))).href) === canonical(pathToFileURL(await fs.realpath(process.argv[1])).href)) {
  await verifyDesktopAssets(path.resolve(process.argv[2] ?? "."));
  console.log("Desktop package verified");
}
