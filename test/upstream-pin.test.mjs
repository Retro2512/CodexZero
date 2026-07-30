import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const upstreamTag = "rust-v0.146.0";
const upstreamVersion = "0.146.0";
const patchName = `codex-${upstreamTag}.patch`;

test("all active build paths use the verified upstream release", async () => {
  const compatibility = JSON.parse(
    await fs.readFile(path.join(root, "config", "compatibility.json"), "utf8")
  );

  assert.equal(compatibility.core.upstreamTag, upstreamTag);
  assert.equal(compatibility.core.upstreamCommit, "e363b08c");

  const requiredPins = new Map([
    ["CONTRIBUTING.md", [upstreamTag, patchName]],
    ["PROJECT_REFERENCE.md", [upstreamTag, patchName]],
    ["docs/compatibility.md", [upstreamTag]],
    [
      ".github/workflows/ci.yml",
      [upstreamTag, patchName, "1.95.0", "--locked"]
    ],
    [
      ".github/workflows/release.yml",
      [upstreamTag, patchName, "1.95.0", "--locked"]
    ],
    ["scripts/install.ps1", [`codex-${upstreamVersion}`]]
  ]);

  for (const [relativePath, pins] of requiredPins) {
    const contents = await fs.readFile(path.join(root, relativePath), "utf8");
    for (const pin of pins) {
      assert.match(
        contents,
        new RegExp(pin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        `${relativePath} must reference ${pin}`
      );
    }
  }
});

test("the pinned patch is complete and contains no merge residue", async () => {
  const patch = await fs.readFile(
    path.join(root, "patches", patchName),
    "utf8"
  );

  assert.match(patch, /^diff --git a\/MODULE\.bazel\.lock/mu);
  assert.match(patch, /codex-rs\/codex-zero-codec\/src\/lib\.rs/u);
  assert.match(patch, /codex-rs\/core\/src\/tools\/exact_duplicate\.rs/u);
  assert.doesNotMatch(patch, /0\.145\.0-alpha\.30/u);
  assert.doesNotMatch(patch, /^(<<<<<<<|=======|>>>>>>>)/mu);
});
