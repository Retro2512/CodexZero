import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const entrypoint = path.join(root, "bin", "codex-zero.mjs");

test("mode switches without modifying prompt or global instruction files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-mode-"));
  const promptRoot = path.join(home, "prompts");
  await fs.mkdir(promptRoot, { recursive: true });
  await fs.copyFile(
    path.join(root, "prompts", "codex-core-lean-v1.md"),
    path.join(promptRoot, "codex-core-lean-v1.md")
  );
  await fs.copyFile(
    path.join(root, "prompts", "manifest.json"),
    path.join(promptRoot, "manifest.json")
  );
  await fs.writeFile(
    path.join(home, "install.json"),
    `${JSON.stringify({ schema: "codex-zero-install-v2", mode: "command-output" })}\n`
  );

  const environment = { ...process.env, CODEX_ZERO_HOME: home };
  const initial = run(["mode"], environment);
  assert.equal(initial.status, 0);
  assert.equal(initial.stdout.trim(), "command-output");

  const changed = run(["mode", "full-lean"], environment);
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /CodexZero mode: full-lean/u);
  const metadata = JSON.parse(await fs.readFile(path.join(home, "install.json"), "utf8"));
  assert.equal(metadata.mode, "full-lean");

  const savings = run(["savings", "--json"], environment);
  assert.equal(savings.status, 0);
  const summary = JSON.parse(savings.stdout);
  assert.equal(summary.promptBenchmark.active, true);
  assert.equal(summary.promptBenchmark.referenceDifferencePerModelRequest, 2814);
  assert.equal(summary.promptBenchmark.referenceReductionPercent, 79.2);
  assert.equal(
    summary.promptBenchmark.referenceScenarioAt50RequestsPerDay.per30Days,
    4221000
  );
});

test("full-lean mode requires the installed bundled prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-mode-missing-"));
  await fs.writeFile(
    path.join(home, "install.json"),
    `${JSON.stringify({ schema: "codex-zero-install-v2", mode: "command-output" })}\n`
  );
  const result = run(
    ["mode", "full-lean"],
    { ...process.env, CODEX_ZERO_HOME: home }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bundled lean prompt is missing/u);
});

function run(args, env) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: root,
    env,
    encoding: "utf8"
  });
}
