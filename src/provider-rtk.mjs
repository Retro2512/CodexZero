import { constants } from "node:fs";
import { accessSync, statSync } from "node:fs";
import path from "node:path";

function executableFile(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathVariable(environment) {
  return Object.keys(environment).find((key) => key.toLowerCase() === "path") || "PATH";
}

// Discovery only inspects PATH. It never invokes RTK or a user command.
export function discovery({ environment = process.env, platform = process.platform, isExecutable = executableFile } = {}) {
  const env = environment && typeof environment === "object" ? environment : {};
  const pathKey = pathVariable(env);
  const pathValue = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const windows = platform === "win32";
  const paths = pathValue.split(windows ? ";" : ":");
  const filename = windows ? "rtk.exe" : "rtk";
  const pathApi = windows ? path.win32 : path.posix;
  for (let entry of paths) {
    entry = entry.trim().replace(/^"(.*)"$/, "$1");
    // Empty or relative PATH entries resolve against the working directory.
    // Do not use them for an automatic tool rewrite.
    if (!pathApi.isAbsolute(entry)) continue;
    const executable = pathApi.join(entry, filename);
    if (isExecutable(executable, platform)) {
      return { available: true, executable, pathKey, platform };
    }
  }
  return { available: false, executable: null, pathKey, platform };
}

export function rtkGuidance(runtime) {
  if (!runtime?.available) return "";
  return "Use rtk for verbose external executables including git, npm and other package managers, builds, linters, and tests. Use rtk grep for rg searches. Never prefix PowerShell cmdlets or shell builtins. Keep commands needing exact output unchanged or use rtk proxy. Batch related read only inspections and search or cap output instead of dumping whole files.";
}

// Retain the resolved RTK directory if the child environment has a different PATH.
export function rtkEnvironment(environment, runtime) {
  if (!runtime?.available || !runtime.executable) return environment;
  const env = environment && typeof environment === "object" ? environment : {};
  const pathKey = pathVariable(env);
  const windows = runtime.platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const separator = windows ? ";" : ":";
  const directory = pathApi.dirname(runtime.executable);
  const current = typeof env[pathKey] === "string" ? env[pathKey] : "";
  const entries = current.split(separator).map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"));
  const matches = (entry) => windows
    ? entry.toLowerCase() === directory.toLowerCase()
    : entry === directory;
  if (entries.some(matches)) return environment;
  return { ...env, [pathKey]: current ? `${directory}${separator}${current}` : directory };
}
