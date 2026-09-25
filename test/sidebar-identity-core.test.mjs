import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { PALETTES, CATEGORIES, validateImage, validateDrawing, validateIdentityPatch, deterministicIdentity } from "../src/sidebar-identity-schema.mjs";
import { IdentityStore } from "../src/sidebar-identity-store.mjs";

async function withStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sidebar-identity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, "identity.json");
}

test("schema has stable curated options and deterministic classification", () => {
  assert.equal(PALETTES.length, 10);
  assert.equal(new Set(PALETTES.map(p => p.id)).size, 10);
  assert.deepEqual([...CATEGORIES], ["fix", "feature", "question", "chat", "research", "design", "refactor", "test"]);
  const first = deterministicIdentity("account:host:thread", { title: "Fix sidebar bug" });
  assert.deepEqual(first, deterministicIdentity("account:host:thread", { title: "Fix sidebar bug" }));
  assert.equal(first.category, "fix");
  assert.equal(first.iconMode, "preset");
  assert.equal(first.drawing, null);
  assert.equal(deterministicIdentity("child", { parent: first, title: "What happened?" }).palette, first.palette);
});

test("drawing validation normalizes safe geometry and rejects executable or oversized input", () => {
  const drawing = validateDrawing({ shapes: [
    { type: "path", d: "M0,0L12 12Z" },
    { type: "circle", cx: 12, cy: 12, r: 4, fill: "none" },
  ] });
  assert.equal(drawing.shapes[0].d, "M 0 0 L 12 12 Z");
  assert.equal(drawing.shapes[0].stroke, "currentColor");
  assert.equal(drawing.shapes[1].fill, "none");
  for (const d of ["M0 0 <script>", "M0 0 L1", "M0 0 Z 1", "M0 0 A1 1 0 2 0 2 2", "M0 0 L1e999 2", "L0 0", "M0 0 X1 1"]) {
    assert.throws(() => validateDrawing({ shapes: [{ type: "path", d }] }), d);
  }
  assert.throws(() => validateDrawing({ shapes: [{ type: "path", d: `M0 0 ${"L1 1 ".repeat(128)}` }] }));
  assert.throws(() => validateDrawing({ shapes: Array.from({ length: 9 }, () => ({ type: "line", x1: 0, y1: 0, x2: 24, y2: 24 })) }));
  assert.throws(() => validateDrawing({ shapes: [{ type: "rect", x: 20, y: 0, width: 5, height: 1 }] }));
  assert.throws(() => validateDrawing({ shapes: [{ type: "circle", cx: 1, cy: 1, r: 2 }] }));
  assert.throws(() => validateDrawing({ shapes: [{ type: "line", x1: 0, y1: 0, x2: 1, y2: 1, onclick: "alert(1)" }] }));
  assert.throws(() => validateDrawing(JSON.parse('{"shapes":[],"__proto__":{}}')));
});

test("identity patch strictly validates every editable field", () => {
  assert.deepEqual(validateIdentityPatch({ color: "#aabbcc", palette: "teal", tone: 3, category: "design", iconMode: "custom", drawing: null, customThreadIcons: true, name: "My thread" }),
    { color: "#AABBCC", palette: "teal", tone: 3, category: "design", iconMode: "custom", drawing: null, customThreadIcons: true, name: "My thread" });
  for (const value of [{ tone: 4 }, { color: "red" }, { category: "misc" }, { name: "" }, { iconMode: "svg" }, { injected: true }, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => validateIdentityPatch(value));
  }
});

test("store persists revisions, copies outputs, and enforces origin and stale revision", async t => {
  const file = await withStore(t);
  const store = new IdentityStore(file);
  const events = [];
  const dispose = store.subscribe((key, record) => events.push([key, record.revision]));
  const initial = await store.snapshot();
  assert.equal(initial.revision, 0);
  const one = await store.update("thread:1", { palette: "blue", category: "feature" }, { origin: "automatic", onlyMissing: true });
  assert.equal(one.revision, 1);
  const two = await store.update("thread:1", { palette: "rose", name: "Chosen" });
  assert.equal(two.revision, 2);
  const three = await store.update("thread:1", { palette: "green", category: "design" }, { origin: "automatic" });
  assert.equal(three.palette, "rose");
  assert.equal(three.category, "design");
  assert.equal(three.origins.palette, "manual");
  assert.equal((await store.update("thread:1", { tone: 1 }, { expectedRevision: 1 })).revision, 3);
  assert.equal((await store.update("thread:1", { palette: "slate" }, { onlyMissing: true })).revision, 3);
  assert.equal((await store.update("thread:1", { tone: 1 }, { onlyMissing: true })).revision, 4);
  assert.equal((await store.get("thread:1")).tone, 1);
  assert.deepEqual(events, [["thread:1", 1], ["thread:1", 2], ["thread:1", 3], ["thread:1", 4]]);
  dispose();
  const snapshot = await store.snapshot();
  snapshot.records["thread:1"].palette = "slate";
  assert.equal((await store.get("thread:1")).palette, "rose");
  assert.equal((await new IdentityStore(file).get("thread:1")).palette, "rose");
});

test("separate store instances serialize writes without lost updates", async t => {
  const file = await withStore(t);
  const left = new IdentityStore(file);
  const right = new IdentityStore(file);
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    jobs.push((i % 2 ? left : right).update(`thread:${i}`, { palette: PALETTES[i % 10].id }));
  }
  await Promise.all(jobs);
  const data = await new IdentityStore(file).snapshot();
  assert.equal(data.revision, 20);
  assert.equal(Object.keys(data.records).length, 20);
});

test("separate processes serialize writes without lost updates", async t => {
  const file = await withStore(t);
  const moduleUrl = new URL("../src/sidebar-identity-store.mjs", import.meta.url).href;
  const code = `import { IdentityStore } from ${JSON.stringify(moduleUrl)};
    const store = new IdentityStore(process.argv[1]);
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.update(process.argv[2] + i, { palette: "blue" })));`;
  const child = prefix => new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, ["--input-type=module", "-e", code, file, prefix], { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    processHandle.stderr.on("data", chunk => { errorOutput += chunk; });
    processHandle.on("error", reject);
    processHandle.on("close", code => code === 0 ? resolve() : reject(new Error(errorOutput || `Child exited ${code}`)));
  });
  await Promise.all([child("a:"), child("b:")]);
  const data = await new IdentityStore(file).snapshot();
  assert.equal(data.revision, 24);
  assert.equal(Object.keys(data.records).length, 24);
});

test("corrupt file is never reset, and prototype-like keys remain data", async t => {
  const file = await withStore(t);
  await fs.writeFile(file, "not json");
  await assert.rejects(new IdentityStore(file).update("thread", { palette: "blue" }));
  assert.equal(await fs.readFile(file, "utf8"), "not json");
  await fs.rm(file);
  const store = new IdentityStore(file);
  await store.update("__proto__", { palette: "blue" });
  assert.equal((await new IdentityStore(file).get("__proto__")).palette, "blue");
  assert.equal({}.palette, undefined);
});

test('image validation accepts bounded originals and rejects unsafe or malformed payloads', () => {
  const uri = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f06" d="M0 0h24v24z"/></svg>';
  const safe = uri('image/svg+xml', safeSvg);
  assert.equal(validateImage(safe), safe);
  assert.deepEqual(validateIdentityPatch({ iconMode: 'asset', image: safe, drawing: null }), { iconMode: 'asset', drawing: null, image: safe });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0u0AAAAASUVORK5CYII=', 'base64');
  assert.equal(validateImage(uri('image/png', png)).startsWith('data:image/png'), true);
  const ico = Buffer.alloc(30); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = 16; ico[7] = 16; ico.writeUInt32LE(8, 14); ico.writeUInt32LE(22, 18);
  assert.equal(validateImage(uri('image/x-icon', ico)).startsWith('data:image/x-icon'), true);
  for (const bad of [
    '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>',
    '<svg viewBox="0 0 24 24"><path onload="alert(1)"/></svg>',
    '<svg viewBox="0 0 24 24"><image href="https://x.invalid/x.png"/></svg>',
    '<svg viewBox="0 0 24 24"><foreignObject/></svg>',
    '<svg viewBox="0 0 24 24"><animate attributeName="x"/></svg>',
    '<svg viewBox="0 0 24 24"><path style="fill: \\75rl(https://x.invalid/a.svg)"/></svg>',
    '<svg viewBox="0 0 24 24"><use href="&#x68;ttps://x.invalid/a.svg"/></svg>',
    '<svg viewBox="0 0 24 24" xml:base="other.svg"><use href="#a"/></svg>',
    '<svg viewBox="0 0 100000 100000"><path/></svg>',
  ]) assert.throws(() => validateImage(uri('image/svg+xml', bad)));
  assert.throws(() => validateImage('data:image/svg+xml,%3Csvg%3E'));
  assert.throws(() => validateImage(uri('text/html', safeSvg)));
  assert.throws(() => validateImage(uri('image/png', Buffer.from('not a png'))));
  assert.throws(() => validateImage(uri('image/svg+xml', safeSvg + ' '.repeat(150 * 1024))));
});

test('asset identity persists image and neutral project fallback', async t => {
  const file = await withStore(t);
  const image = `data:image/svg+xml;base64,${Buffer.from('<svg viewBox="0 0 2 2"><path fill="#f00" d="M0 0h2v2z"/></svg>').toString('base64')}`;
  const store = new IdentityStore(file);
  await store.update('project', { iconMode: 'asset', image });
  assert.equal((await new IdentityStore(file).get('project')).image, image);
  assert.equal(deterministicIdentity(JSON.stringify(['host', 'project', 'id'])).palette, 'slate');
});

