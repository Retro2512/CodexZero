import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const entrypoint = path.resolve(import.meta.dirname, "..", "bin", "codex-zero.mjs");
const environment = {
  ...process.env,
  CODEX_ZERO_HOME: path.join(os.tmpdir(), `codex-zero-artifacts-cli-${process.pid}`),
  CODEX_ZERO_ARTIFACT_DIR: path.join(os.tmpdir(), `codex-zero-artifacts-cli-${process.pid}`, "artifacts")
};

function run(args, env = environment) {
  return spawnSync(process.execPath, [entrypoint, "artifacts", ...args], {
    env,
    encoding: "utf8"
  });
}

test("artifact commands reject unknown or unsafe options before maintenance", () => {
  for (const args of [
    [],
    ["prune", "--older-than-days", "0"],
    ["prune", "--older-than-days", "NaN"],
    ["prune", "--older-than-days"],
    ["prune", "--bogus"],
    ["repair", "--dry-run"]
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout}`);
  }
});

test("artifact maintenance commands operate only on the selected store", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-artifacts-command-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, "artifacts");
  const directory = path.join(root, "sha256");
  await fs.mkdir(directory, { recursive: true });
  const object = path.join(directory, "a".repeat(64));
  await fs.writeFile(object, "artifact");
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  await fs.utimes(object, old, old);
  const env = { ...environment, CODEX_ZERO_HOME: home, CODEX_ZERO_ARTIFACT_DIR: root };

  const preview = run(["prune", "--older-than-days", "30", "--dry-run", "--json"], env);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).eligible, 1);
  assert.equal(JSON.parse(preview.stdout).removed, 0);
  assert.equal(await fs.readFile(object, "utf8"), "artifact");
  const previewText = run(["prune", "--older-than-days", "30", "--dry-run"], env);
  assert.equal(previewText.status, 0, previewText.stderr);
  assert.match(previewText.stdout, /Would remove 1 artifacts/u);

  const pruned = run(["prune", "--older-than-days", "30", "--json"], env);
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.equal(JSON.parse(pruned.stdout).removed, 1);
  await assert.rejects(fs.stat(object), { code: "ENOENT" });

  const repaired = run(["repair", "--json"], env);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).skipped, 0);
});
