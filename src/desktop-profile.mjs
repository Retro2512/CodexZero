import os from "node:os";
import path from "node:path";

// Desktop uses its matching embedded core and the existing Codex home. Do not
// copy credentials, rollouts, skills, or live Chromium databases into a new home.
export function desktopProfileEnvironment({ environment = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const result = { ...environment, CODEX_HOME: environment.CODEX_HOME || paths.join(home, ".codex") };
  const zeroHome = environment.CODEX_ZERO_HOME || paths.join(result.CODEX_HOME, "codexzero");
  const optimizedSqlite = environment.CODEX_ZERO_SQLITE_HOME || paths.join(zeroHome, "sqlite");
  const normalize = value => {
    const resolved = paths.resolve(value).replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  // The optimized Rust CLI uses a different schema history. A Desktop launched
  // from that environment must not accidentally inherit its isolated index.
  if (result.CODEX_SQLITE_HOME && normalize(result.CODEX_SQLITE_HOME) === normalize(optimizedSqlite)) {
    delete result.CODEX_SQLITE_HOME;
  }
  return result;
}
