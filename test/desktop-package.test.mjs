import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareProviderLauncher } from '../src/provider-launcher.mjs';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const repository = path.resolve(import.meta.dirname, '..');
const ps = (script, args) => run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repository, 'scripts', script), ...args], { windowsHide: true });

test('packaged provider launcher works after moving the entire application', { skip: !windows }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cz-portable-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'build');
  await fs.mkdir(path.join(source, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(source, 'bin'));
  await fs.copyFile(process.execPath, path.join(source, 'runtime/node.exe'));
  await fs.writeFile(path.join(source, 'bin/provider-core.mjs'), 'console.log(JSON.stringify({ root: import.meta.dirname, args: process.argv.slice(2) }));');
  const previous = process.env.CODEX_ZERO_PROVIDER_CORE;
  process.env.CODEX_ZERO_PROVIDER_CORE = path.join(source, 'fixture-core.exe');
  try { await prepareProviderLauncher('unused', { home: source }); }
  finally {
    if (previous === undefined) delete process.env.CODEX_ZERO_PROVIDER_CORE;
    else process.env.CODEX_ZERO_PROVIDER_CORE = previous;
  }
  const installed = path.join(temporary, 'Installed app with spaces');
  await fs.rename(source, installed);
  const args = ['--version', 'argument with spaces', 'a"quoted\\value'];
  const { stdout } = await run(path.join(installed, 'provider-runtime/codex-custom-models.exe'), args, { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.args, args);
  assert.equal(result.root.toLowerCase(), path.join(installed, 'bin').toLowerCase());
});

test('desktop archive installation switches builds without touching Codex data', { skip: !windows }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cz-install-desktop-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'package');
  const installed = path.join(temporary, 'Programs/CodexZero');
  const home = path.join(temporary, '.codex');
  await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'auth.json'), 'fixture account');
  for (const file of ['CodexZero.exe', 'desktop/ChatGPT.exe', 'runtime/node.exe', 'provider-runtime/codex-custom-models.exe', 'assets/codexzero.ico']) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), 'fixture');
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version: '0.8.0' }));
  await fs.writeFile(path.join(source, 'local-build.json'), '{}');
  const args = ['-PackageRoot', source, '-InstallRoot', installed, '-NoLaunch', '-SkipShortcuts'];
  await ps('install-desktop.ps1', args);
  const first = await fs.readFile(path.join(installed, 'current-build.txt'), 'utf8');
  await ps('install-desktop.ps1', args);
  const second = await fs.readFile(path.join(installed, 'current-build.txt'), 'utf8');
  assert.notEqual(first, second);
  assert.equal(await fs.readFile(path.join(installed, first, 'CodexZero.exe'), 'utf8'), 'fixture');
  assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), 'fixture account');
  await fs.unlink(path.join(source, 'desktop/ChatGPT.exe'));
  await assert.rejects(ps('install-desktop.ps1', args), /Incomplete desktop package/);
  assert.equal(await fs.readFile(path.join(installed, 'current-build.txt'), 'utf8'), second);
  await ps('uninstall-desktop.ps1', ['-InstallRoot', installed, '-SkipShortcuts']);
  await assert.rejects(fs.access(installed));
  assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), 'fixture account');
});

test('Windows release contains a desktop setup and full archive while CLI stays optional', async () => {
  const workflow = await fs.readFile(path.join(repository, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /build-desktop-release\.ps1/);
  assert.match(workflow, /build-desktop-setup\.ps1/);
  assert.match(workflow, /Compress-Archive -Path desktop-package/);
  assert.match(workflow, /Compress-Archive -Path package/);
  assert.match(workflow, /codex-zero-desktop-windows-x64\.zip/);
  const bootstrap = await fs.readFile(path.join(repository, 'scripts/bootstrap.ps1'), 'utf8');
  assert.match(bootstrap, /CodexZero-Setup-windows-x64\.exe/);
  assert.match(bootstrap, /Get-FileHash/);
  const installer = await fs.readFile(path.join(repository, 'scripts/install.ps1'), 'utf8');
  assert.match(installer, /!\$CliOnly/);
  assert.match(installer, /install-desktop\.ps1/);
});
