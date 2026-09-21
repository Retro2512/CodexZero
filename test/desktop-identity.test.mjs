import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../assets/native-provider-identity.cjs', import.meta.url), 'utf8');
function setup(env = {}) {
  const listeners = new Map(); const shortcuts = [];
  const app = {
    on(event, callback) { listeners.set(event, callback); },
    whenReady() { return Promise.resolve(); },
    getPath(name) { return path.resolve('fixture', name); }
  };
  vm.runInNewContext(source, {
    process: { resourcesPath: path.resolve('build', 'desktop', 'resources'), env },
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'electron') return { app, shell: { writeShortcutLink(...args) { shortcuts.push(args); return true; } } };
      throw new Error('Unexpected dependency');
    }
  });
  return { listeners, shortcuts };
}

test('CodexZero windows use their own icon and relaunch identity', () => {
  const { listeners, shortcuts } = setup();
  const calls = {}; const events = new Map();
  listeners.get('browser-window-created')({}, {
    setIcon(value) { calls.icon = value; },
    setTitle(value) { calls.title = value; },
    setAppDetails(value) { calls.details = value; },
    on(event, callback) { events.set(event, callback); }
  });
  assert.equal(calls.title, 'CodexZero');
  assert.equal(calls.details.appId, 'CodexZero.Desktop');
  assert.ok(calls.icon.endsWith(path.join('assets', 'codexzero.ico')));
  assert.equal(calls.details.relaunchCommand, `"${path.resolve('build', 'CodexZero.exe')}"`);
  let prevented = false;
  events.get('page-title-updated')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(shortcuts.length, 0);
});

test('CodexZero startup does not modify system shortcuts', async () => {
  const env = { CODEX_ZERO_SETUP_SHORTCUT: '1' };
  const { shortcuts } = setup(env);
  await Promise.resolve();
  assert.equal(env.CODEX_ZERO_SETUP_SHORTCUT, '1');
  assert.equal(shortcuts.length, 0);
});
