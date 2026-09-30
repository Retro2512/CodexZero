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

function compileFixtureLauncher(outputPath, fixtureSource = String.raw`
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
}`) {
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content) return content;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
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

  const launchRoot = path.join(fixtureRoot, "launch with spaces");
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
  await fs.writeFile(path.join(buildRoot, "CodexZero.exe"), "invalid executable");
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

async function successfulHandoff(t, exitDuringIdentityRead = false) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-update-success-"));
  let parent;
  let updater;
  t.after(async () => {
    for (const child of [updater, parent]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise(resolve => child.once("close", resolve));
        child.kill();
        await closed;
      }
    }
    await removeFixture(fixtureRoot);
  });

  const launchRoot = path.join(fixtureRoot, "launch");
  const buildRoot = path.join(launchRoot, "updates", "next");
  await fs.mkdir(buildRoot, { recursive: true });
  compileFixtureLauncher(path.join(launchRoot, "CodexZero.exe"));
  compileFixtureLauncher(path.join(buildRoot, "CodexZero.exe"));
  await fs.writeFile(path.join(buildRoot, "local-build.json"), "{}");
  await fs.writeFile(path.join(launchRoot, "current-build.txt"), "updates\\previous");

  parent = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::Out.WriteLine((Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks); [Console]::Out.Flush(); if ($env:CODEXZERO_EXIT_GATE) { while (!(Test-Path -LiteralPath $env:CODEXZERO_EXIT_GATE)) { Start-Sleep -Milliseconds 25 } } else { $null = [Console]::In.ReadLine() }"
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEXZERO_EXIT_GATE: exitDuringIdentityRead ? path.join(fixtureRoot, "exit-parent") : "" } }
  );
  const parentStartTicks = await waitForLine(parent.stdout);

  const args = updaterArguments(launchRoot, buildRoot, parent.pid, parentStartTicks);
  let injected = source;
  if (exitDuringIdentityRead) {
    // Stop the real fixture process after Get-Process has returned its object,
    // but before identity access. This reproduces the PS5.1 CI race without
    // relying on a particular machine speed or sleep duration.
    const anchor = "                $null = $parent.Handle";
    assert.equal(source.split(anchor).length, 2);
    injected = source.replace(anchor, `
                [IO.File]::WriteAllText($env:CODEXZERO_EXIT_GATE, 'exit')
                $raceDeadline = [DateTime]::UtcNow.AddSeconds(10)
                while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
                    if ([DateTime]::UtcNow -gt $raceDeadline) { throw 'Fixture process did not exit' }
                    Start-Sleep -Milliseconds 25
                }
${anchor}`);
  } else {
    const anchor = "                while (-not $parent.WaitForExit(250)) {";
    assert.equal(source.split(anchor).length, 2);
    injected = source.replace(anchor, `[IO.File]::WriteAllText($env:CODEXZERO_WAIT_GATE, 'waiting')\n${anchor}`);
  }
  const stage = path.join(launchRoot, "updates", ".stage-fixture");
  await fs.mkdir(stage);
  const fixtureScript = path.join(stage, "complete.ps1");
  await fs.writeFile(fixtureScript, injected);
  args[args.indexOf("-File") + 1] = fixtureScript;
  const readyFile = path.join(stage, "handoff-ready.txt");
  args.push("-ReadyFile", readyFile);

  updater = spawn(
    "powershell.exe",
    args,
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEXZERO_EXIT_GATE: exitDuringIdentityRead ? path.join(fixtureRoot, "exit-parent") : "",
        CODEXZERO_WAIT_GATE: path.join(fixtureRoot, "waiting-for-parent") } }
  );
  const output = [];
  updater.stdout.on("data", (chunk) => output.push(chunk));
  updater.stderr.on("data", (chunk) => output.push(chunk));
  const completion = new Promise((resolve, reject) => {
    updater.on("error", reject);
    updater.on("close", resolve);
  });

  if (!exitDuringIdentityRead) {
    assert.equal(await waitForFile(readyFile), "ready");
    assert.equal(await waitForFile(path.join(fixtureRoot, "waiting-for-parent")), "waiting");
    assert.equal(updater.exitCode, null);
    assert.equal(
      await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"),
      "updates\\previous"
    );
    parent.stdin.end("exit\n");
  }

  const status = await completion;
  assert.equal(status, 0, Buffer.concat(output).toString("utf8"));
  assert.equal(
    await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"),
    path.join("updates", "next")
  );
  assert.equal(
    await waitForFile(path.join(buildRoot, "launcher-started.txt")),
    "started"
  );
  await assert.rejects(fs.access(path.join(launchRoot, "launcher-started.txt")));
}

test("desktop update waits for the exact parent and starts the selected build without relying on an old stable launcher", {
  skip: process.platform !== "win32", timeout: 30000
}, t => successfulHandoff(t));

test("desktop update survives the parent exiting between discovery and identity access", {
  skip: process.platform !== "win32", timeout: 30000
}, t => successfulHandoff(t, true));

test("production Windows launcher confirms startup and rolls back early desktop exits", {
  skip: process.platform !== "win32", timeout: 60000
}, async t => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cz-real-launcher-"));
  t.after(() => removeFixture(fixtureRoot));
  const launchRoot = path.join(fixtureRoot, "installed app");
  const buildRoot = path.join(launchRoot, "updates", "next build");
  const desktop = path.join(buildRoot, "desktop");
  await fs.mkdir(desktop, { recursive: true });
  compileFixtureLauncher(path.join(launchRoot, "CodexZero.exe"));
  compileFixtureLauncher(path.join(desktop, "ChatGPT.exe"), String.raw`
using System;
using System.IO;
using System.Threading;
using System.Reflection;
public static class DesktopFixture {
  public static int Main() {
    string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    File.WriteAllText(Path.Combine(root, "environment.txt"),
      Environment.GetEnvironmentVariable("CODEX_ZERO_LAUNCH_ROOT") + "\n" +
      Environment.GetEnvironmentVariable("CODEX_ZERO_UPDATE_STARTUP"));
    string exit = Path.Combine(root, "exit-code.txt");
    if (File.Exists(exit)) return Int32.Parse(File.ReadAllText(exit));
    while (!File.Exists(Path.Combine(root, "stop.txt"))) Thread.Sleep(50);
    return 0;
  }
}`);
  await fs.writeFile(path.join(buildRoot, "local-build.json"), JSON.stringify({
    desktopBinary: path.join(desktop, "ChatGPT.exe"), core: "core.exe", launcher: "provider.exe"
  }));
  const compiled = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    path.join(root, "scripts", "build-codexzero-launcher.ps1"), "-BuildRoot", buildRoot,
    "-IconPath", path.join(root, "assets", "codexzero.ico")], { encoding: "utf8", windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  // The helper must not trust a successful spawn or exit code zero from an
  // Electron instance that quits before startup (for example a profile lock).
  for (const code of [0, 23]) {
    await fs.writeFile(path.join(desktop, "exit-code.txt"), String(code));
    await fs.writeFile(path.join(launchRoot, "current-build.txt"), "updates\\previous");
    const result = runUpdater(launchRoot, buildRoot);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"), "updates\\previous");
    assert.equal(await fs.readFile(path.join(launchRoot, "update-failed.txt"), "utf8"), "CodexZero update failed.");
    assert.equal(await waitForFile(path.join(launchRoot, "launcher-started.txt")), "started");
    await fs.unlink(path.join(launchRoot, "launcher-started.txt"));
  }
  await fs.unlink(path.join(desktop, "exit-code.txt"));
  try {
    const result = runUpdater(launchRoot, buildRoot);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await fs.readFile(path.join(launchRoot, "current-build.txt"), "utf8"), path.join("updates", "next build"));
    assert.equal(await fs.readFile(path.join(desktop, "environment.txt"), "utf8"), launchRoot + "\n");
    await assert.rejects(fs.access(path.join(launchRoot, "launcher-started.txt")));
  } finally {
    await fs.writeFile(path.join(desktop, "stop.txt"), "stop");
  }
});

test("hidden Windows handoff outlives the Node process that started it through the broker", {
  skip: process.platform !== "win32", timeout: 30000
}, async t => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cz-orphan-handoff-"));
  t.after(() => removeFixture(fixtureRoot));
  const buildRoot = path.join(fixtureRoot, "updates", "next");
  const stage = path.join(fixtureRoot, "updates", ".stage-test");
  await fs.mkdir(buildRoot, { recursive: true });
  await fs.mkdir(stage);
  compileFixtureLauncher(path.join(buildRoot, "CodexZero.exe"));
  await fs.writeFile(path.join(fixtureRoot, "CodexZero.exe"), "unused old launcher");
  await fs.writeFile(path.join(buildRoot, "local-build.json"), "{}");
  await fs.writeFile(path.join(fixtureRoot, "current-build.txt"), "updates\\previous");
  const handoff = path.join(stage, "complete.ps1");
  await fs.copyFile(scriptPath, handoff);
  const ready = path.join(stage, "ready.txt");
  const host = path.join(fixtureRoot, "host.cjs");
  await fs.writeFile(host, `
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs');
const ticks=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  '(Get-Process -Id '+process.pid+').StartTime.ToUniversalTime().Ticks'],{windowsHide:true,encoding:'utf8'}).trim();
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
  ${JSON.stringify(path.join(root, "scripts", "start-desktop-update.ps1"))},
  '-Handoff',${JSON.stringify(handoff)},'-LaunchRoot',${JSON.stringify(fixtureRoot)},'-BuildRoot',${JSON.stringify(buildRoot)},
  '-ParentProcessId',String(process.pid),'-ParentStartTicks',ticks,'-ReadyFile',${JSON.stringify(ready)},
  '-CancelFile',${JSON.stringify(path.join(stage, "cancel.txt"))}], {windowsHide:true});
const deadline=Date.now()+10000;
const timer=setInterval(()=>{
  if(fs.existsSync(${JSON.stringify(ready)})) {clearInterval(timer);process.exit(0);}
  if(Date.now()>deadline) {fs.writeFileSync(${JSON.stringify(path.join(stage, "cancel.txt"))},'cancelled');clearInterval(timer);process.exit(1);}
},50);
`);
  const result = spawnSync(process.execPath, [host], { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The host is already gone; the helper must still switch and reopen.
  assert.equal(await waitForFile(path.join(buildRoot, "launcher-started.txt")), "started");
  assert.equal(await fs.readFile(path.join(fixtureRoot, "current-build.txt"), "utf8"), path.join("updates", "next"));
});

test("an uncertain startup timeout does not reopen an older build alongside the new one", {
  skip: process.platform !== "win32", timeout: 30000
}, async t => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cz-slow-launcher-"));
  t.after(() => removeFixture(fixtureRoot));
  const buildRoot = path.join(fixtureRoot, "updates", "next");
  await fs.mkdir(buildRoot, { recursive: true });
  compileFixtureLauncher(path.join(fixtureRoot, "CodexZero.exe"));
  compileFixtureLauncher(path.join(buildRoot, "CodexZero.exe"), String.raw`
using System.IO;
using System.Threading;
using System.Reflection;
public static class SlowLauncher {
  public static void Main() {
    Thread.Sleep(1000);
    File.WriteAllText(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "late-start.txt"), "started");
  }
}`);
  await fs.writeFile(path.join(buildRoot, "local-build.json"), "{}");
  await fs.writeFile(path.join(fixtureRoot, "current-build.txt"), "updates\\previous");
  const injected = path.join(fixtureRoot, "timeout.ps1");
  await fs.writeFile(injected, source.replace("$launched.WaitForExit(15000)", "$launched.WaitForExit(1)"));
  const args = updaterArguments(fixtureRoot, buildRoot);
  args[args.indexOf("-File") + 1] = injected;
  const result = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(await waitForFile(path.join(buildRoot, "late-start.txt")), "started");
  assert.equal(await fs.readFile(path.join(fixtureRoot, "current-build.txt"), "utf8"), path.join("updates", "next"));
  await assert.rejects(fs.access(path.join(fixtureRoot, "launcher-started.txt")));
  await assert.rejects(fs.access(path.join(fixtureRoot, "update-failed.txt")));
});
