import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { DESKTOP_ASSETS, verifyDesktopAssets } from "../scripts/verify-desktop-assets.mjs";

test("release Desktop assets and their module dependencies are complete", async () => {
  await verifyDesktopAssets(path.resolve(import.meta.dirname, ".."));
});

test("a package missing its pricing or cache UI cannot pass verification", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-release-assets-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const relative of DESKTOP_ASSETS) {
    if (relative === "assets/model-pricing.mjs") continue;
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), "fixture");
  }
  await assert.rejects(verifyDesktopAssets(root), /model-pricing/);
  await fs.writeFile(path.join(root, "assets/model-pricing.mjs"), "fixture");
  await fs.rm(path.join(root, "assets/native-cache-ui.mjs"));
  await assert.rejects(verifyDesktopAssets(root), /native-cache-ui/);
});

test("release assembly and both installers include the context cache assets", async () => {
  for (const relative of [".github/workflows/release.yml", "scripts/install.ps1", "scripts/install.sh"]) {
    const source = await fs.readFile(new URL(`../${relative}`, import.meta.url), "utf8");
    assert.ok(source.includes("native-cache-ui.mjs"), relative);
    assert.ok(source.includes("model-pricing.mjs"), relative);
  }
});
