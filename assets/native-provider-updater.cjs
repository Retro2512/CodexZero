"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { archiveName, selectRelease, stageRelease } = require("./native-provider-update-release.cjs");

// Implement the native updater contract so the existing sidebar control,
// progress state and restart action remain the sole update UI.
class CodexZeroUpdater {
  constructor(options, dependencies = {}) {
    this.options = options;
    this.electron = dependencies.electron || require("electron");
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.prepare = dependencies.prepare || prepareUpdate;
    this.version = dependencies.version || require("./codexzero-update-version.json").version;
    this.archive = dependencies.archive || archiveName();
    this.state = "idle";
    this.release = null;
    this.busy = null;
  }
  async initialize() {
    this.electron.ipcMain.handle("codex_desktop:check-for-updates", async event => {
      if (this.options.isTrustedIpcEvent(event)) await this.checkForUpdates();
    });
    // Do not hold up application startup or display network failures on launch.
    void this.checkForUpdates();
    this.timer = setInterval(() => void this.checkForUpdates(), 30 * 60 * 1000);
    this.timer.unref();
    this.electron.app.once("will-quit", () => clearInterval(this.timer));
  }
  hasUpdater() { return archiveName() !== null; }
  getUnavailableReason() { return this.hasUpdater() ? null : "unsupported platform"; }
  getIsUpdateReady() { return !!this.release && this.state === "ready"; }
  getSupportsAutoInstallWhenIdle() { return false; }
  getIsDownloadedUpdateReady() { return false; }
  getDownloadProgressPercent() { return null; }
  getInstallProgressPercent() { return null; }
  getDownloadedUpdateAppBrand() { return null; }
  getUpdateLifecycleState() { return this.state; }
  getRelaunchNotice() { return null; }
  hasInAppUpdatesPolicyChanges() { return false; }
  latchInAppUpdatesEnabledForLaunch() {}
  setSparkleQueryParams() {}
  setAutomaticBackgroundDownloadsEnabled() {}
  relaunchStaleMacExecutableIfNeeded() { return false; }
  showRelaunchNoticeForDebug() {}
  startUpdaterAfterStartupFailure() { return this.checkForUpdates(); }
  setState(state) {
    this.state = state;
    this.options.onUpdateReadyChanged?.(this.getIsUpdateReady());
    this.options.onUpdateLifecycleStateChanged?.(state);
  }
  checkForUpdates() {
    if (!this.hasUpdater() || this.busy) return this.busy || Promise.resolve();
    this.busy = (async () => {
      try {
        const response = await this.fetch("https://api.github.com/repos/Retro2512/CodexZero/releases/latest", {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "CodexZero" },
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error("Release check failed");
        this.release = selectRelease(await response.json(), this.version, this.archive);
        this.setState(this.release ? "ready" : "idle");
      } catch { /* Keep a previously discovered update available while offline. */ }
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
  installUpdatesIfAvailable() {
    if (this.busy || !this.release) return this.busy || Promise.resolve(false);
    this.busy = (async () => {
      this.setState("downloading");
      try {
        await this.prepare(this.release, this.electron, state => this.setState(state));
        if (this.options.onInstallUpdatesRequested) this.options.onInstallUpdatesRequested();
        else this.electron.app.quit();
        return true;
      } catch {
        this.setState("ready");
        await this.electron.dialog.showMessageBox({ type: "error", buttons: ["OK"], message: "Could not update CodexZero. Try again." });
        return false;
      }
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
}

async function prepareUpdate(release, electron, setState) {
  if (process.platform === "darwin") return prepareMacUpdate(release, setState);
  const root = path.resolve(process.resourcesPath, "..", "..");
  const launchRoot = path.resolve(process.env.CODEX_ZERO_LAUNCH_ROOT || root);
  await fs.access(path.join(launchRoot, "CodexZero.exe"));
  const stage = path.join(launchRoot, "updates", `.stage-${randomUUID()}`);
  const build = path.join(launchRoot, "updates", `${release.version}-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  const archive = await stageRelease(release, stage);
  setState("installing");
  const runner = promisify(execFile);
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helper = path.join(stage, "prepare.ps1");
  // Only fixed script text is executed. All paths are passed as arguments.
  await fs.writeFile(helper, `param([string]$Archive,[string]$Package,[string]$Build,[string]$Version)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $prefix = [IO.Path]::GetFullPath($Package).TrimEnd('\\') + '\\'
  $total = 0L
  if ($zip.Entries.Count -gt 100000) { throw 'Invalid update archive' }
  foreach ($entry in $zip.Entries) {
    $total += $entry.Length
    if ($total -gt 4GB) { throw 'Update archive is too large' }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($Package, $entry.FullName))
    if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.Contains(':')) { throw 'Invalid update archive' }
  }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $Package
$metadata = Get-Content -Raw -LiteralPath (Join-Path $Package 'package.json') | ConvertFrom-Json
if ($metadata.version -ne $Version) { throw 'Update version mismatch' }
& (Join-Path $Package 'scripts\\build-provider-local.ps1') -OutputDirectory $Build
if ($LASTEXITCODE -ne 0) { throw 'Update build failed' }
if (!(Test-Path -LiteralPath (Join-Path $Build 'CodexZero.exe'))) { throw 'Update launcher missing' }
`, "utf8");
  await runner(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
    "-Archive", archive, "-Package", path.join(stage, "package"), "-Build", build, "-Version", release.version],
  // The first update on a computer may also download the official desktop.
  { windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  // Copy the handoff out of the running build before exiting.
  const handoff = path.join(stage, "complete.ps1");
  await fs.copyFile(path.join(root, "scripts", "complete-desktop-update.ps1"), handoff);
  const { stdout } = await runner(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`], { windowsHide: true });
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", handoff,
    "-LaunchRoot", launchRoot, "-BuildRoot", build, "-ParentProcessId", String(process.pid), "-ParentStartTicks", stdout.trim()],
  { detached: true, windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}

// macOS replaces the whole application bundle after the app quits. The new
// bundle is assembled outside it, from the release package and the pinned
// official desktop, so a failed preparation leaves the running app untouched.
async function prepareMacUpdate(release, setState) {
  const root = path.join(process.resourcesPath, "codexzero");
  const bundle = path.resolve(process.env.CODEX_ZERO_LAUNCH_ROOT || path.resolve(process.resourcesPath, "..", ".."));
  if (path.extname(bundle) !== ".app") throw new Error("Invalid application location");
  const stage = path.join(os.homedir(), "Library", "Caches", "CodexZero", "updates", `.stage-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  const archive = await stageRelease(release, stage);
  setState("installing");
  const runner = promisify(execFile);
  const { stdout: listing } = await runner("/usr/bin/tar", ["-tzf", archive], { maxBuffer: 64 * 1024 * 1024 });
  for (const entry of listing.split("\n").filter(Boolean)) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) throw new Error("Invalid update archive");
  }
  const packageRoot = path.join(stage, "package");
  await fs.mkdir(packageRoot);
  await runner("/usr/bin/tar", ["-xzf", archive, "-C", packageRoot]);
  const metadata = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.version !== release.version) throw new Error("Update version mismatch");
  const build = path.join(stage, "CodexZero.app");
  // The first update on a computer may also download the official desktop.
  await runner(path.join(packageRoot, "runtime", "node"), [path.join(packageRoot, "bin", "desktop-macos.mjs"), "build",
    "--package", packageRoot, "--output", build], { timeout: 60 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
  const handoff = path.join(stage, "complete.sh");
  await fs.copyFile(path.join(root, "scripts", "complete-desktop-update-macos.sh"), handoff);
  const child = spawn("/bin/sh", [handoff, bundle, build, String(process.pid)], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
module.exports = { CodexZeroUpdater };
