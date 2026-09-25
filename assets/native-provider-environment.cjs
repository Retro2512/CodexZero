"use strict";
// macOS opens CodexZero through Launch Services, so no launcher passes its
// environment as on Windows. Configure it before the application reads it.
const os = require("node:os");
const path = require("node:path");

if (process.platform === "darwin" && process.env.CODEX_ZERO_DESKTOP !== "1") {
  const root = path.join(process.resourcesPath, "codexzero");
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  Object.assign(process.env, {
    CODEX_ZERO_DESKTOP: "1",
    CODEX_CLI_PATH: path.join(root, "provider-runtime", "codex-custom-models"),
    CODEX_APP_SERVER_FORCE_CLI: "1",
    CODEX_ZERO_PROVIDER_CORE: path.join(process.resourcesPath, "codex"),
    CODEX_ZERO_LAUNCH_ROOT: path.resolve(process.resourcesPath, "..", ".."),
    // Reuse the existing Codex home. Chromium keeps its own separate profile.
    CODEX_HOME: codexHome
  });
  if (!process.env.CODEX_ELECTRON_USER_DATA_PATH?.trim()) {
    process.env.CODEX_ELECTRON_USER_DATA_PATH = path.join(home, "Library", "Application Support", "CodexZero", "Browser");
  }
  // Match the Windows launcher: never inherit the optimized CLI's isolated index.
  const zeroHome = process.env.CODEX_ZERO_HOME || path.join(codexHome, "codexzero");
  const optimizedSqlite = process.env.CODEX_ZERO_SQLITE_HOME || path.join(zeroHome, "sqlite");
  if (process.env.CODEX_SQLITE_HOME && path.resolve(process.env.CODEX_SQLITE_HOME) === path.resolve(optimizedSqlite)) {
    delete process.env.CODEX_SQLITE_HOME;
  }
}
