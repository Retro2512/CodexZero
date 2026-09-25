import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrandHintsClient } from "../src/sidebar-brand-client.mjs";

test("brand worker reads, caches, invalidates, and closes without main thread scanning", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-brand-worker-"));
  const client = createBrandHintsClient();
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const image = path.join(root, "icon.svg");
  const icon = color => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="M0 0h24v24H0z"/></svg>`;
  await fs.writeFile(image, icon("#123456"));
  const first = await client.readBrandHints(root);
  assert.equal(first.icon.source, "icon.svg");
  assert.deepEqual(first.colors, ["#123456"]);
  await fs.writeFile(image, icon("#abcdef"));
  assert.deepEqual((await client.readBrandHints(root)).colors, ["#123456"]);
  await client.invalidateBrandHints(root);
  assert.deepEqual((await client.readBrandHints(root)).colors, ["#abcdef"]);
  await assert.rejects(client.readBrandHints("https://example.invalid"), TypeError);
  await client.close();
  await assert.rejects(client.readBrandHints(root), /closed/);
});
