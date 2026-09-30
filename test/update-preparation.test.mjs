import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const runFile = promisify(execFile);
const updaterPath = new URL("../assets/native-provider-updater.cjs", import.meta.url);
const require = createRequire(import.meta.url);

async function embeddedPreparationScript() {
  const source = await fs.readFile(updaterPath, "utf8");
  const match = /await fs\.writeFile\(helper,\s*(`[^`]*`),\s*"utf8"\);/.exec(source);
  assert.ok(match, "fixed preparation script template is embedded");
  assert.equal(match[1].includes("${"), false, "preparation script must remain a literal template");
  const script = vm.runInNewContext(match[1], Object.create(null), { timeout: 100 });
  assert.equal(typeof script, "string");
  return script;
}

function powershellPath() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function runPowerShell(scriptPath, args = [], timeout = 30_000) {
  return runFile(powershellPath(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...args,
  ], { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
}

async function createFixtureSource(root, version) {
  const source = path.join(root, `source-${version}`);
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "update-fixture", version }), "utf8");
  await fs.writeFile(path.join(source, "scripts", "build-provider-local.ps1"), `param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'CodexZero.exe'), 'fixture launcher')
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'builder-ran.txt'), 'yes')
$global:LASTEXITCODE = 0
`, "utf8");
  return source;
}

async function createFixtureArchive(root, source, name) {
  const archive = path.join(root, name);
  const compressor = path.join(root, `compress-${name}.ps1`);
  await fs.writeFile(compressor, `param([string]$Source,[string]$Archive)
$ErrorActionPreference = 'Stop'
Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $Archive -Force
`, "utf8");
  await runPowerShell(compressor, ["-Source", source, "-Archive", archive]);
  return archive;
}

async function createTraversalArchive(root) {
  const archive = path.join(root, "traversal.zip");
  const creator = path.join(root, "create-traversal.ps1");
  await fs.writeFile(creator, `param([string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($Archive, [IO.Compression.ZipArchiveMode]::Create)
try {
  $entry = $zip.CreateEntry('../outside.txt')
  $writer = [IO.StreamWriter]::new($entry.Open())
  try { $writer.Write('escaped') } finally { $writer.Dispose() }
} finally { $zip.Dispose() }
`, "utf8");
  await runPowerShell(creator, ["-Archive", archive]);
  return archive;
}

async function runPreparation(helper, archive, packageDirectory, buildDirectory, version) {
  return runPowerShell(helper, [
    "-Archive", archive,
    "-Package", packageDirectory,
    "-Build", buildDirectory,
    "-Version", version,
  ]);
}

test("native updater contains one fixed preparation script literal", async () => {
  const script = await embeddedPreparationScript();
  assert.match(script, /Update version mismatch/);
  assert.match(script, /Invalid update archive/);
});

test("embedded Windows preparation validates and builds only an expected safe archive", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-prepare-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const helper = path.join(root, "prepare.ps1");
  await fs.writeFile(helper, await embeddedPreparationScript(), "utf8");

  const parser = path.join(root, "parse.ps1");
  await fs.writeFile(parser, `param([string]$Script)
$ErrorActionPreference = 'Stop'
[ScriptBlock]::Create((Get-Content -Raw -LiteralPath $Script)) | Out-Null
`, "utf8");
  await runPowerShell(parser, ["-Script", helper]);

  const matchingSource = await createFixtureSource(root, "0.8.0");
  const matchingArchive = await createFixtureArchive(root, matchingSource, "matching.zip");
  const matchingPackage = path.join(root, "matching-package");
  const matchingBuild = path.join(root, "matching-build");
  await runPreparation(helper, matchingArchive, matchingPackage, matchingBuild, "0.8.0");
  assert.equal(await fs.readFile(path.join(matchingBuild, "CodexZero.exe"), "utf8"), "fixture launcher");
  assert.equal(await fs.readFile(path.join(matchingBuild, "builder-ran.txt"), "utf8"), "yes");

  const mismatchedSource = await createFixtureSource(root, "0.7.9");
  const mismatchedArchive = await createFixtureArchive(root, mismatchedSource, "mismatched.zip");
  const mismatchedBuild = path.join(root, "mismatched-build");
  await assert.rejects(
    runPreparation(helper, mismatchedArchive, path.join(root, "mismatched-package"), mismatchedBuild, "0.8.0"),
    error => {
      assert.match(String(error.stderr), /Update version mismatch/);
      return true;
    },
  );
  await assert.rejects(fs.access(path.join(mismatchedBuild, "builder-ran.txt")));
  await assert.rejects(fs.access(path.join(mismatchedBuild, "CodexZero.exe")));

  const traversalArchive = await createTraversalArchive(root);
  const traversalPackage = path.join(root, "traversal-package");
  const traversalBuild = path.join(root, "traversal-build");
  const outside = path.join(root, "outside.txt");
  await assert.rejects(
    runPreparation(helper, traversalArchive, traversalPackage, traversalBuild, "0.8.0"),
    error => {
      assert.match(String(error.stderr), /Invalid update archive/);
      return true;
    },
  );
  await assert.rejects(fs.access(outside));
  await assert.rejects(fs.access(traversalPackage));
  await assert.rejects(fs.access(path.join(traversalBuild, "builder-ran.txt")));
});

test("Windows preparation waits for the new helper before allowing quit", {
  skip: process.platform !== "win32", timeout: 60000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-update-end-to-end-"));
  let cancel;
  t.after(async () => {
    await cancel?.();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const launchRoot = path.join(root, "installed with spaces");
  const runningRoot = path.join(launchRoot, "updates", "old");
  await fs.mkdir(path.join(runningRoot, "scripts"), { recursive: true });
  await fs.writeFile(path.join(launchRoot, "CodexZero.exe"), "not executed while parent lives");
  await fs.writeFile(path.join(launchRoot, "current-build.txt"), "updates\\old");
  await fs.writeFile(path.join(runningRoot, "scripts", "complete-desktop-update.ps1"), "throw 'Old helper must not run'");
  const source = await createFixtureSource(root, "0.9.3");
  await fs.copyFile(new URL("../scripts/complete-desktop-update.ps1", import.meta.url), path.join(source, "scripts", "complete-desktop-update.ps1"));
  await fs.copyFile(new URL("../scripts/start-desktop-update.ps1", import.meta.url), path.join(source, "scripts", "start-desktop-update.ps1"));
  await fs.appendFile(path.join(source, "scripts", "build-provider-local.ps1"), `
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'complete-desktop-update.ps1') -Destination (Join-Path $OutputDirectory 'scripts')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-desktop-update.ps1') -Destination (Join-Path $OutputDirectory 'scripts')
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'local-build.json'), '{}')
`);
  const archive = await createFixtureArchive(root, source, "release.zip");
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(updaterPath, "utf8") + "\nmodule.exports.prepareUpdate = prepareUpdate;", {
    module, setTimeout, process: {
      platform: "win32", pid: process.pid,
      resourcesPath: path.join(runningRoot, "desktop", "resources"),
      env: { ...process.env, CODEX_ZERO_LAUNCH_ROOT: launchRoot }
    },
    require(name) {
      if (name === "./native-provider-update-release.cjs") return { stageRelease: async () => archive };
      return require(name);
    }
  });
  const states = [];
  cancel = await module.exports.prepareUpdate({ version: "0.9.3" }, {}, state => states.push(state));
  assert.deepEqual(states, ["installing"]);
  assert.equal(typeof cancel, "function");
  const stage = (await fs.readdir(path.join(launchRoot, "updates"))).find(name => name.startsWith(".stage-"));
  assert.equal(await fs.readFile(path.join(launchRoot, "updates", stage, "handoff-ready.txt"), "utf8"), "ready");
  assert.equal(await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"), "updates\\old");
  await cancel();
  const readyFile = path.join(launchRoot, "updates", stage, "handoff-ready.txt");
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.access(readyFile); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await assert.rejects(fs.access(readyFile));
  assert.equal(await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"), "updates\\old");
});
