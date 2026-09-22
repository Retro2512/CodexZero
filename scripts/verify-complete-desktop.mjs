import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyDesktopAssets } from './verify-desktop-assets.mjs';

const root = path.resolve(process.argv[2]);
await verifyDesktopAssets(root);
const manifest = JSON.parse((await fs.readFile(path.join(root, 'local-build.json'), 'utf8')).replace(/^\uFEFF/, ''));
for (const key of ['desktopBinary', 'core', 'launcher']) {
  const value = manifest[key];
  if (typeof value !== 'string' || path.isAbsolute(value) || value.includes(':') || path.relative(root, path.resolve(root, value)).startsWith('..')) {
    throw new Error(`Nonportable desktop manifest: ${key}`);
  }
  await fs.access(path.join(root, value));
}
for (const file of ['CodexZero.exe', 'runtime/node.exe', 'desktop/resources/app.asar']) await fs.access(path.join(root, file));
const { stdout } = await promisify(execFile)(path.join(root, manifest.launcher), ['--version'], {
  env: { ...process.env, CODEX_ZERO_PROVIDER_CORE: path.join(root, manifest.core) },
  windowsHide: true, timeout: 30000,
});
if (!/^codex-cli\s+/m.test(stdout)) throw new Error('Packaged desktop core did not start.');
console.log('Complete desktop package verified');
