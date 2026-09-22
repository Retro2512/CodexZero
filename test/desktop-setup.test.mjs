import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts', 'build-desktop-setup.ps1');
const installer = readFileSync(path.join(root, 'scripts', 'windows-desktop.iss'), 'utf8');
const windows = process.platform === 'win32';

test('desktop setup is per user, independent, and opens the complete application', () => {
  assert.match(installer, /DefaultDirName=\{localappdata\}\\Programs\\CodexZero/);
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /ArchitecturesAllowed=x64compatible/);
  assert.match(installer, /Source: "\{#PackageRoot\}\\\*"; DestDir: "\{app\}"/);
  assert.match(installer, /Name: "\{userprograms\}\\CodexZero"; Filename: "\{app\}\\CodexZero.exe"/);
  assert.match(installer, /Name: "\{userdesktop\}\\CodexZero"/);
  assert.match(installer, /Flags: nowait postinstall skipifsilent; Check: CanLaunch/);
});

test('setup preserves user data and never kills original Codex processes', () => {
  assert.match(installer, /CloseApplications=no/);
  assert.match(installer, /RestartApplications=no/);
  assert.match(installer, /if Pos\(Root, Executable\) = 1 then Exit/);
  assert.match(installer, /complete-desktop-update\.ps1/);
  assert.match(installer, /updates\\\.stage-/);
  assert.match(installer, /\\complete\.ps1/);
  assert.match(installer, /function PrepareToInstall/);
  assert.match(installer, /function InitializeUninstall/);
  assert.doesNotMatch(installer, /taskkill|TerminateProcess|\.Terminate\(|\[UninstallDelete\]|\[InstallDelete\]/i);
  assert.doesNotMatch(installer, /\.codex|\{userappdata\}|\\CodexZero\\Browser/);
});

test('setup resets update selection only after successful file installation', () => {
  assert.match(installer, /Excludes: "current-build.txt,update-failed.txt,updates\\\*"/);
  assert.match(installer, /if CurStep = ssPostInstall then begin[\s\S]*DeleteFile\(ExpandConstant\('\{app\}\\current-build.txt'\)\)/);
  assert.match(installer, /if not InstallReady then\s+RaiseException/);
  assert.match(installer, /function CanLaunch\(\): Boolean;[\s\S]*?Result := InstallReady/);
});

test('silent installs open the application unless NOLAUNCH is supplied', () => {
  assert.match(installer, /Flags: nowait postinstall skipifnotsilent; Check: CanLaunchSilently/);
  assert.match(installer, /Result := WizardSilent and CanLaunch\(\)/);
  assert.match(installer, /CompareText\(ParamStr\(Index\), '\/NOLAUNCH'\) = 0 then\s+Result := False/);
});

test('running process check excludes this process and only the verified uninstall parent', () => {
  assert.match(installer, /external 'GetCurrentProcessId@kernel32\.dll stdcall'/);
  assert.match(installer, /SELECT ProcessId, ParentProcessId, ExecutablePath, CommandLine FROM Win32_Process/);
  assert.match(installer, /if Process\.ProcessId = CurrentPid then Continue/);
  assert.match(installer, /if Process\.ProcessId = CurrentPid then\s+UninstallerParentPid := Process\.ParentProcessId/);
  assert.match(installer, /if CheckingUninstall and \(Process\.ProcessId = UninstallerParentPid\) then\s+if CompareText\(Executable, ExpandConstant\('\{uninstallexe\}'\)\) = 0 then Continue/);
  assert.match(installer, /function InitializeUninstall\(\): Boolean;\s+begin\s+CheckingUninstall := True/);
  assert.doesNotMatch(installer, /unins000\.exe|ExtractFileName\(Executable\)/);
});

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codexzero-setup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packageRoot = path.join(dir, 'package with spaces');
  const output = path.join(dir, 'output with spaces');
  mkdirSync(packageRoot);
  for (const relative of ['CodexZero.exe', 'desktop/ChatGPT.exe', 'runtime/node.exe',
    'assets/codexzero.ico', 'bin/codex-zero.mjs', 'package.json', 'local-build.json']) {
    const file = path.join(packageRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, relative === 'package.json' ? '{"version":"1.2.3"}' : relative.endsWith('.json') ? '{}' : 'fixture');
  }
  for (const relative of ['provider-runtime', 'src', 'scripts']) mkdirSync(path.join(packageRoot, relative));
  const compiler = path.join(dir, 'fake-iscc.cmd');
  writeFileSync(compiler, `@echo off\r\necho fixture > "${path.join(output, 'CodexZero-Setup-windows-x64.exe')}"\r\nexit /b 0\r\n`);
  return { dir, packageRoot, output, compiler };
}

function build(f, extra = {}) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-PackageRoot', f.packageRoot, '-OutputDirectory', extra.output ?? f.output, '-IsccPath', f.compiler], { encoding: 'utf8' });
}

test('builder rejects incomplete packages before compiling', { skip: !windows }, t => {
  const f = fixture(t);
  rmSync(path.join(f.packageRoot, 'runtime', 'node.exe'));
  const result = build(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required package file is missing: runtime\\node.exe/);
  assert.equal(existsSync(f.output), false);
});

test('builder rejects output inside package to avoid recursive packaging', { skip: !windows }, t => {
  const f = fixture(t);
  const result = build(f, { output: path.join(f.packageRoot, 'output') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OutputDirectory must be outside PackageRoot/);
});

test('builder accepts a complete package and paths with spaces', { skip: !windows }, t => {
  const f = fixture(t);
  const result = build(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CodexZero-Setup-windows-x64.exe/);
  assert.equal(existsSync(path.join(f.output, 'CodexZero-Setup-windows-x64.exe')), true);
});

test('builder propagates compiler failures', { skip: !windows }, t => {
  const f = fixture(t);
  writeFileSync(f.compiler, '@echo off\r\nexit /b 9\r\n');
  const result = build(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Inno Setup failed with exit code 9/);
});
