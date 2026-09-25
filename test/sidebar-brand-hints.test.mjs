import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { invalidateBrandHints, readBrandHints } from '../src/sidebar-brand-hints.mjs';

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sidebar-brand-hints-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, relative, contents) {
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function svg(content = '<path fill="#ABCDEF" stroke="#123456"/>') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${content}</svg>`;
}

test('reads only explicit branding fields and a bounded safe SVG hint', async (t) => {
  const root = await makeRoot(t);
  await put(root, 'package.json', JSON.stringify({
    name: 'sample-brand',
    private: true,
    scripts: { secret: 'not a hint' },
  }));
  await put(root, 'manifest.json', JSON.stringify({
    theme_color: '#123ABC',
    background_color: '#ffffff',
    icons: [{ src: 'https://example.invalid/icon.svg' }],
  }));
  await put(root, 'src/app/globals.css', `
    /* --brand: #010203; */
    :root { --primary: #445566; --brand: #778899; --surface: #ffffff; }
  `);
  await put(root, 'public/favicon.svg', svg());

  const hints = await readBrandHints(root);
  assert.deepEqual(hints.colors, ['#123abc', '#ffffff', '#445566', '#778899', '#abcdef', '#123456']);
  assert.equal(hints.name, 'sample-brand');
  assert.equal(hints.icon.source, 'public/favicon.svg');
  assert.match(hints.icon.svg, /viewBox="0 0 24 24"/);
  assert.ok(Buffer.byteLength(hints.icon.svg, 'utf8') <= 8192);
  assert.deepEqual(hints.sources, [
    'package.json',
    'manifest.json',
    'src/app/globals.css',
    'public/favicon.svg',
  ]);
  assert.deepEqual(Object.keys(hints).sort(), ['colors', 'icon', 'image', 'name', 'sources']);
  assert.match(hints.image, /^data:image\/svg\+xml;base64,/);
  assert.equal(JSON.stringify(hints).includes('not a hint'), false);
});

test('ignores SVGs with active content, external references, or oversized documents', async (t) => {
  const root = await makeRoot(t);
  const invalid = [
    svg('<script>alert(1)</script>'),
    svg('<foreignObject><div>content</div></foreignObject>'),
    svg('<image href="https://example.invalid/image.png"/>'),
    svg('<use href="other.svg#shape"/>'),
    svg('<path onload="alert(1)" fill="#aabbcc"/>'),
    svg('<path style="fill: url(https://example.invalid/a.svg#x)"/>'),
  ];
  for (const [index, value] of invalid.entries()) {
    await put(root, `public/icon.svg`, value);
    await invalidateBrandHints(root);
    const hints = await readBrandHints(root);
    assert.equal(hints.icon, undefined, `unsafe SVG ${index} should be skipped`);
  }

  await put(root, 'public/icon.svg', svg('<path fill="#aabbcc"/>') + ' '.repeat(8192));
  await invalidateBrandHints(root);
  const oversized = await readBrandHints(root);
  assert.equal(oversized.icon, undefined);
  assert.deepEqual(oversized.colors, []);
});

test('does not read a candidate symlink that resolves outside the root', async (t) => {
  const root = await makeRoot(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sidebar-brand-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, 'logo.svg');
  await writeFile(outsideFile, svg('<path fill="#aabbcc"/>'));

  try {
    await symlink(outside, path.join(root, 'assets'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const hints = await readBrandHints(root);
  assert.equal(hints.icon, undefined);
  assert.deepEqual(hints.colors, []);
  assert.deepEqual(hints.sources, []);
});

test('enforces finite file and byte budgets', async (t) => {
  const root = await makeRoot(t);
  await put(root, 'package.json', JSON.stringify({ name: 'oversized' }) + ' '.repeat(90 * 1024));
  await put(root, 'manifest.json', JSON.stringify({ theme_color: '#102030' }));
  await put(root, 'public/icon.svg', svg());
  const hints = await readBrandHints(root);
  assert.equal(hints.name, undefined);
  assert.equal(hints.icon.source, 'public/icon.svg');
  assert.equal(hints.colors[0], '#102030');
  for (let i = 0; i < 200; i++) await put(root, `assets/unrelated-${i}.svg`, svg());
  await invalidateBrandHints(root);
  assert.equal((await readBrandHints(root)).icon.source, 'public/icon.svg');
});
test('caches results by canonical root and supports explicit invalidation', async (t) => {
  const root = await makeRoot(t);
  await put(root, 'manifest.json', JSON.stringify({ theme_color: '#111111' }));
  const first = await readBrandHints(root);
  await put(root, 'manifest.json', JSON.stringify({ theme_color: '#222222' }));
  const cached = await readBrandHints(root);
  assert.deepEqual(cached.colors, ['#111111']);

  await invalidateBrandHints(root);
  const refreshed = await readBrandHints(root);
  assert.deepEqual(refreshed.colors, ['#222222']);

  const file = path.join(root, 'manifest.json');
  assert.equal((await readFile(file, 'utf8')).includes('#222222'), true);
});

test('rejects invalid roots with a TypeError', async () => {
  for (const root of [undefined, null, {}, '', '   ', 'https://example.invalid']) {
    await assert.rejects(readBrandHints(root), TypeError);
  }
});


test('explicit manifest icon outranks filenames and preserves full color SVG', async t => {
  const root = await makeRoot(t);
  await put(root, 'public/favicon.svg', svg('<path fill="#111111"/>'));
  const original = svg('<path fill="#336699"/><circle cx="12" cy="12" r="4" fill="#F0A020"/>');
  await put(root, 'public/brand/app.svg', original);
  await put(root, 'public/manifest.json', JSON.stringify({ icons: [{ src: '/brand/app.svg' }], theme_color: '#abc' }));
  const hints = await readBrandHints(root);
  assert.equal(hints.icon.source, 'public/brand/app.svg');
  assert.equal(Buffer.from(hints.image.split(',')[1], 'base64').toString(), original);
  assert.deepEqual(hints.colors.slice(0, 3), ['#aabbcc', '#336699', '#f0a020']);
});

test('Android launcher vector is converted without losing fill and stroke colors', async t => {
  const root = await makeRoot(t);
  await put(root, 'app/src/main/AndroidManifest.xml', '<manifest><application android:icon="@mipmap/ic_launcher"/></manifest>');
  await put(root, 'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', '<adaptive-icon><foreground android:drawable="@drawable/ic_launcher_foreground"/></adaptive-icon>');
  await put(root, 'app/src/main/res/drawable/ic_launcher_foreground.xml', '<vector android:viewportWidth="64" android:viewportHeight="64"><path android:fillColor="#F5FAFF" android:pathData="M0,0h64v64h-64z"/><group android:pivotX="32" android:pivotY="32" android:scaleX="0.8" android:scaleY="0.8"><path android:strokeColor="#63BDEB" android:strokeWidth="6" android:pathData="M1,1L40,40"/></group></vector>');
  const hints = await readBrandHints(root);
  assert.equal(hints.icon.source, 'app/src/main/res/drawable/ic_launcher_foreground.xml');
  const image = Buffer.from(hints.image.split(',')[1], 'base64').toString();
  assert.match(image, /fill="#F5FAFF"/);
  assert.match(image, /stroke="#63BDEB"/);
  assert.deepEqual(hints.colors, ['#f5faff', '#63bdeb']);
});

test('known nested app root is considered without broad repository traversal', async t => {
  const root = await makeRoot(t);
  await put(root, 'companion-app/app.json', JSON.stringify({ expo: { name: 'Companion', icon: './assets/icon.svg' } }));
  await put(root, 'companion-app/assets/icon.svg', svg('<path fill="#ff6600"/>'));
  await put(root, 'unrelated/app.json', JSON.stringify({ expo: { icon: './icon.svg' } }));
  const hints = await readBrandHints(root);
  assert.equal(hints.name, 'Companion');
  assert.equal(hints.icon.source, 'companion-app/assets/icon.svg');
  assert.equal(hints.sources.includes('unrelated/app.json'), false);
});

test('explicit image references cannot escape the root or load remote content', async t => {
  const root = await makeRoot(t);
  await put(root, 'public/manifest.json', JSON.stringify({ icons: [
    { src: '../../outside.svg' }, { src: 'https://example.invalid/x.svg' }, { src: 'javascript:alert(1).svg' },
  ] }));
  const hints = await readBrandHints(root);
  assert.equal(hints.image, undefined);
  assert.equal(hints.icon, undefined);
});

test('CSS and Android eight digit colors use their respective alpha order', async t => {
  const root = await makeRoot(t);
  await put(root, 'styles.css', ':root { --brand: #112233ff; --accent: #abc; }');
  await put(root, 'app/src/main/res/values/colors.xml', '<resources><color name="brand_primary">#ff445566</color></resources>');
  const hints = await readBrandHints(root);
  assert.deepEqual(hints.colors, ['#445566', '#112233', '#aabbcc']);
});
