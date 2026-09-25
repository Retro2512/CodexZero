// Verifies an installed CodexZero.app: identity, signature, the custom model
// core, and a real launch through Launch Services with an isolated profile.
// Usage: node verify-desktop-macos.mjs /path/to/CodexZero.app
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const app = path.resolve(process.argv[2] ?? "");
const plist = path.join(app, "Contents", "Info.plist");
const resources = path.join(app, "Contents", "Resources");
const value = async key => (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).stdout.trim();
const absent = async key => run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]).then(() => false, () => true);
const check = (condition, message) => { if (!condition) throw new Error(message); };

check(await value("CFBundleIdentifier") === "com.codexzero.desktop", "Unexpected bundle identifier");
check(await value("CrProductDirName") === "CodexZero/Browser", "The browser profile is not separate");
for (const key of ["CFBundleURLTypes", "CFBundleDocumentTypes", "UTExportedTypeDeclarations", "NSDockTilePlugIn"]) {
  check(await absent(key), `The app still claims ${key}`);
}
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
for (const file of ["codexzero.icns", "codex", "codexzero/runtime/node", "codexzero/bin/provider-core.mjs", "codexzero/provider-runtime/codex-custom-models"]) {
  await fs.access(path.join(resources, file));
}
const { stdout: version } = await run(path.join(resources, "codexzero", "provider-runtime", "codex-custom-models"), ["--version"], {
  env: { ...process.env, CODEX_ZERO_PROVIDER_CORE: path.join(resources, "codex") }, timeout: 30000
});
check(/^codex-cli\s+/m.test(version), "The custom model core did not start");

// Launch like the Dock does and wait for the app to start its model core.
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-launch-"));
const processes = async () => (await run("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 })).stdout
  .split("\n").map(line => line.trim()).filter(line => line.includes(path.join(app, "Contents") + path.sep));
try {
  await run("/usr/bin/open", ["-n", "-g", "--env", `CODEX_HOME=${path.join(profile, "home")}`,
    "--env", `CODEX_ELECTRON_USER_DATA_PATH=${path.join(profile, "browser")}`, app]);
  let started = false;
  for (let attempt = 0; attempt < 120 && !started; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    started = (await processes()).some(line => line.includes("codexzero/bin/provider-core.mjs"));
  }
  if (!started) {
    console.error((await processes()).join("\n") || "CodexZero is not running.");
    const reports = path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
    for (const name of await fs.readdir(reports).catch(() => [])) {
      if (/ChatGPT|Codex/i.test(name)) console.error(`Crash report: ${name}\n${(await fs.readFile(path.join(reports, name), "utf8")).slice(0, 4000)}`);
    }
    throw new Error("CodexZero did not start its model core");
  }
  console.log("CodexZero started its model core");
} finally {
  for (const line of await processes()) {
    const pid = Number(line.split(/\s+/)[0]);
    if (pid) { try { process.kill(pid); } catch {} }
  }
  // Let the app finish writing its profile before removing it.
  for (let attempt = 0; attempt < 30 && (await processes()).length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
console.log("CodexZero Mac app verified");
