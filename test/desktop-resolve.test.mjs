import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const windows = process.platform === 'win32';
const repository = path.resolve(import.meta.dirname, '..');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const pinned = JSON.parse(await fs.readFile(path.join(repository, 'scripts/desktop-upstream.json'), 'utf8'));

const ps = (script, args) => run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
  { windowsHide: true, maxBuffer: 1024 * 1024 });

async function fixture(t, entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cz-resolve-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const writer = path.join(dir, 'write-package.ps1');
  await fs.writeFile(writer, `param([string]$Archive, [string]$Entries)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($Archive, 'Create')
try {
  foreach ($name in (Get-Content -Raw -LiteralPath $Entries | ConvertFrom-Json)) {
    $writer = [IO.StreamWriter]::new($zip.CreateEntry($name).Open())
    try { $writer.Write($name) } finally { $writer.Dispose() }
  }
} finally { $zip.Dispose() }
`);
  const list = path.join(dir, 'entries.json');
  await fs.writeFile(list, JSON.stringify(entries));
  const archive = path.join(dir, 'download.msix');
  await ps(writer, ['-Archive', archive, '-Entries', list]);
  const bytes = await fs.readFile(archive);
  const manifest = path.join(dir, 'desktop-upstream.json');
  await fs.writeFile(manifest, JSON.stringify({
    ...pinned, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
  }));
  return { dir, archive, manifest, cache: path.join(dir, 'cache'), staging: path.join(dir, 'staging') };
}

const resolve = (f, extra = []) => ps(path.join(repository, 'scripts/resolve-desktop.ps1'),
  ['-SkipInstalled', '-Manifest', f.manifest, '-CacheRoot', f.cache, '-StagingRoot', f.staging, ...extra]);

test('official desktop package is verified, cached and extracted with decoded names', { skip: !windows }, async t => {
  const f = await fixture(t, ['[Content_Types].xml', 'AppxManifest.xml', 'app/ChatGPT.exe',
    'app/resources/node_modules/%40scope/pkg/index.js', 'app/locales/en%20US.pak']);
  const { stdout } = await resolve(f, ['-DesktopPackage', f.archive]);
  assert.equal(stdout.trim().toLowerCase(), path.join(f.staging, 'app', 'ChatGPT.exe').toLowerCase());
  assert.equal(await fs.readFile(path.join(f.staging, 'app/resources/node_modules/@scope/pkg/index.js'), 'utf8'),
    'app/resources/node_modules/%40scope/pkg/index.js');
  await fs.access(path.join(f.staging, 'app/locales/en US.pak'));
  await assert.rejects(fs.access(path.join(f.staging, 'AppxManifest.xml')));
  await assert.rejects(fs.access(f.archive));
  assert.deepEqual(await fs.readdir(f.cache), [`${pinned.version}.msix`]);

  // A later build reuses the verified download without the original file.
  await fs.rm(f.staging, { recursive: true });
  await resolve(f);
  await fs.access(path.join(f.staging, 'app/ChatGPT.exe'));
});

test('desktop package that does not match the pinned checksum is rejected', { skip: !windows }, async t => {
  const f = await fixture(t, ['app/ChatGPT.exe']);
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  await fs.writeFile(f.manifest, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
  await assert.rejects(resolve(f, ['-DesktopPackage', f.archive]), /failed verification/);
  await assert.rejects(fs.access(path.join(f.cache, `${pinned.version}.msix`)));
});

test('desktop package entries cannot escape the staging folder', { skip: !windows }, async t => {
  for (const entry of ['app/..%2F..%2Fescape.txt', 'app/%5C..%5Cescape.txt', 'app/C%3A/escape.txt']) {
    const f = await fixture(t, ['app/ChatGPT.exe', entry]);
    await assert.rejects(resolve(f, ['-DesktopPackage', f.archive]), /Invalid desktop package/);
    await assert.rejects(fs.access(path.join(f.dir, 'escape.txt')));
  }
});

test('desktop package must come from an official address', { skip: !windows }, async t => {
  const f = await fixture(t, ['app/ChatGPT.exe']);
  const manifest = JSON.parse(await fs.readFile(f.manifest, 'utf8'));
  for (const url of ['http://persistent.oaistatic.com/ChatGPT-x64.msix', 'https://example.com/ChatGPT-x64.msix']) {
    await fs.writeFile(f.manifest, JSON.stringify({ ...manifest, url }));
    await assert.rejects(resolve(f, ['-DesktopPackage', f.archive]), /official HTTPS address/);
  }
});

test('pinned desktop matches the version the native patches were verified against', async () => {
  assert.match(pinned.url, new RegExp(`^https://persistent\\.oaistatic\\.com/codex-app-prod/releases/${pinned.version.replaceAll('.', '\\.')}/ChatGPT-x64\\.msix$`));
  assert.match(pinned.sha256, /^[0-9a-f]{64}$/);
  assert.ok(pinned.size > 100 * 1024 ** 2);
  const profile = await fs.readFile(path.join(repository, 'docs/desktop-profile.md'), 'utf8');
  assert.ok(profile.includes(`\`${pinned.version}\``), 'desktop profile documents the pinned build');
});
