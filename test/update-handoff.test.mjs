import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts", "complete-desktop-update.ps1");
const source = await fs.readFile(scriptPath, "utf8");
const removeFixture = (fixtureRoot) => fs.rm(fixtureRoot, {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50
});

function updaterArguments(launchRoot, buildRoot, parentProcessId = "2147483647", parentStartTicks = "1") {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    scriptPath,
    "-LaunchRoot",
    launchRoot,
    "-BuildRoot",
    buildRoot,
    "-ParentProcessId",
    String(parentProcessId),
    "-ParentStartTicks",
    String(parentStartTicks)
  ];
}

function runUpdater(launchRoot, buildRoot) {
  return spawnSync(
    "powershell.exe",
    updaterArguments(launchRoot, buildRoot),
    { encoding: "utf8", windowsHide: true }
  );
}

function compileFixtureLauncher(outputPath) {
  const fixtureSource = String.raw`
using System;
using System.IO;
using System.Reflection;

public static class FixtureLauncher
{
    [STAThread]
    public static void Main()
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        File.WriteAllText(Path.Combine(root, "launcher-started.txt"), "started");
    }
}`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$source = [Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $env:CODEXZERO_FIXTURE_EXE -OutputType WindowsApplication"
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CODEXZERO_FIXTURE_EXE: outputPath },
      input: fixtureSource,
      windowsHide: true
    }
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function waitForLine(stream) {
  return await new Promise((resolve, reject) => {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) resolve(buffered.slice(0, newline).trim());
    });
    stream.on("error", reject);
    stream.on("end", () => reject(new Error("Process ended before writing its start time")));
  });
}

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test("desktop update handoff has bounded process and atomic pointer safeguards", () => {
  assert.match(source, /AddSeconds\(120\)/u);
  assert.match(source, /StartTime\.ToUniversalTime\(\)\.Ticks/u);
  assert.match(source, /File\]::Replace/u);
  assert.match(source, /File\]::Move/u);
  assert.match(source, /UTF8Encoding\]::new\(\$false\)/u);
  assert.match(source, /Start-Process[^\n]+-WindowStyle Hidden/u);
  assert.doesNotMatch(source, /Stop-Process|\.Kill\s*\(/u);
});

test("desktop update rejects a build outside updates without changing the pointer", {
  skip: process.platform !== "win32"
}, async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-update-path-"));
  t.after(() => removeFixture(fixtureRoot));

  const launchRoot = path.join(fixtureRoot, "launch");
  const outsideBuild = path.join(fixtureRoot, "outside-build");
  await fs.mkdir(path.join(launchRoot, "updates"), { recursive: true });
  await fs.mkdir(outsideBuild, { recursive: true });
  await fs.writeFile(path.join(launchRoot, "CodexZero.exe"), "not launched");
  await fs.writeFile(path.join(outsideBuild, "CodexZero.exe"), "fixture");
  await fs.writeFile(path.join(outsideBuild, "local-build.json"), "{}");
  await fs.writeFile(path.join(launchRoot, "current-build.txt"), "updates\\previous");

  const result = runUpdater(launchRoot, outsideBuild);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"),
    "updates\\previous"
  );
  assert.equal(
    await fs.readFile(path.join(launchRoot, "update-failed.txt"), "utf8"),
    "CodexZero update failed."
  );
  assert.doesNotMatch(
    await fs.readFile(path.join(launchRoot, "update-failed.txt"), "utf8"),
    new RegExp(outsideBuild.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")
  );
});

test("failed launcher start restores the previous pointer", {
  skip: process.platform !== "win32"
}, async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-update-rollback-"));
  t.after(() => removeFixture(fixtureRoot));

  const launchRoot = path.join(fixtureRoot, "launch");
  const buildRoot = path.join(launchRoot, "updates", "next");
  await fs.mkdir(buildRoot, { recursive: true });
  await fs.writeFile(path.join(launchRoot, "CodexZero.exe"), "invalid executable");
  await fs.writeFile(path.join(buildRoot, "CodexZero.exe"), "fixture");
  await fs.writeFile(path.join(buildRoot, "local-build.json"), "{}");
  await fs.writeFile(path.join(launchRoot, "current-build.txt"), "updates\\previous");

  const result = runUpdater(launchRoot, buildRoot);
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"),
    "updates\\previous"
  );
  assert.equal(
    await fs.readFile(path.join(launchRoot, "update-failed.txt"), "utf8"),
    "CodexZero update failed."
  );
});

test("desktop update waits for the exact parent before switching and starts the stable launcher", {
  skip: process.platform !== "win32"
}, async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-update-success-"));
  t.after(() => removeFixture(fixtureRoot));

  const launchRoot = path.join(fixtureRoot, "launch");
  const buildRoot = path.join(launchRoot, "updates", "next");
  await fs.mkdir(buildRoot, { recursive: true });
  compileFixtureLauncher(path.join(launchRoot, "CodexZero.exe"));
  await fs.writeFile(path.join(buildRoot, "CodexZero.exe"), "fixture");
  await fs.writeFile(path.join(buildRoot, "local-build.json"), "{}");
  await fs.writeFile(path.join(launchRoot, "current-build.txt"), "updates\\previous");

  const parent = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Out.WriteLine((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1400"
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  t.after(() => {
    if (parent.exitCode === null) parent.kill();
  });
  const parentStartTicks = await waitForLine(parent.stdout);

  const updater = spawn(
    "powershell.exe",
    updaterArguments(launchRoot, buildRoot, parent.pid, parentStartTicks),
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  const output = [];
  updater.stdout.on("data", (chunk) => output.push(chunk));
  updater.stderr.on("data", (chunk) => output.push(chunk));

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"),
    "updates\\previous"
  );

  const status = await new Promise((resolve, reject) => {
    updater.on("error", reject);
    updater.on("close", resolve);
  });
  assert.equal(status, 0, Buffer.concat(output).toString("utf8"));
  assert.equal(
    await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"),
    path.join("updates", "next")
  );
  assert.equal(
    await waitForFile(path.join(launchRoot, "launcher-started.txt")),
    "started"
  );
});
