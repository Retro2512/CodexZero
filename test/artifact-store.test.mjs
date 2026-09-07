import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { storeRaw } from "../src/artifact-store.mjs";

test("stores raw bytes exactly by SHA-256", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-artifacts-"));
  const raw = Buffer.from([0, 255, 13, 10, 27, 91, 51, 49, 109]);
  const artifact = await storeRaw(raw, root);
  assert.deepEqual(await fs.readFile(artifact.path), raw);
  assert.equal(artifact.rawByteCount, raw.length);
});

test("concurrent identical writes publish one verified object without temporary residue", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const raw = Buffer.alloc(64 * 1024, 42);
  const results = await Promise.all(Array.from({ length: 32 }, () => storeRaw(raw, root)));
  assert.ok(results.every((result) => result.path === results[0].path));
  assert.deepEqual(await fs.readFile(results[0].path), raw);
  assert.deepEqual(await fs.readdir(path.join(root, "sha256")), [results[0].sha256]);
});

test("a corrupt existing artifact is never replaced", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-corrupt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const raw = Buffer.from("original");
  const result = await storeRaw(raw, root);
  await fs.writeFile(result.path, "corrupt");
  await assert.rejects(storeRaw(raw, root), /corruption/);
  assert.equal(await fs.readFile(result.path, "utf8"), "corrupt");
});
