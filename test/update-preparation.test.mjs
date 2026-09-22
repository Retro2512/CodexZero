import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const updaterPath = new URL("../assets/native-provider-updater.cjs", import.meta.url);

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

  // Complete releases install directly, even when stock Codex is not installed.
  const desktopSource = await createFixtureSource(root, "0.8.1");
  for (const file of ['CodexZero.exe', 'local-build.json', 'desktop/ChatGPT.exe', 'runtime/node.exe', 'provider-runtime/codex-custom-models.exe']) {
    await fs.mkdir(path.dirname(path.join(desktopSource, file)), { recursive: true });
    await fs.writeFile(path.join(desktopSource, file), 'packaged desktop');
  }
  const desktopArchive = await createFixtureArchive(root, desktopSource, 'desktop.zip');
  const desktopBuild = path.join(root, 'desktop-build');
  await runPreparation(helper, desktopArchive, path.join(root, 'desktop-package'), desktopBuild, '0.8.1');
  assert.equal(await fs.readFile(path.join(desktopBuild, 'CodexZero.exe'), 'utf8'), 'packaged desktop');
  await assert.rejects(fs.access(path.join(desktopBuild, 'builder-ran.txt')));
  await fs.unlink(path.join(desktopSource, 'runtime/node.exe'));
  const incomplete = await createFixtureArchive(root, desktopSource, 'incomplete.zip');
  await assert.rejects(runPreparation(helper, incomplete, path.join(root, 'incomplete-package'), path.join(root, 'incomplete-build'), '0.8.1'), /Incomplete desktop update/);

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
