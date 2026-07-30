import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("prompt manifest matches the bundled file and keeps progress updates", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "prompts", "manifest.json"), "utf8")
  );
  const prompt = await fs.readFile(
    path.join(root, "prompts", manifest.bundled_prompt.path)
  );

  assert.equal(prompt.byteLength, manifest.bundled_prompt.bytes);
  assert.equal(
    createHash("sha256").update(prompt).digest("hex"),
    manifest.bundled_prompt.sha256
  );
  assert.equal(manifest.bundled_prompt.tokens, 1356);
  assert.equal(manifest.bundled_prompt.keeps_concise_intermediary_updates, true);
  assert.match(prompt.toString("utf8"), /^## Intermediary updates$/mu);
});
