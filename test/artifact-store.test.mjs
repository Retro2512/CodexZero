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
