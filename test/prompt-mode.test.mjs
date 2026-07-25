import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildLaunchArguments } from "../src/cli.mjs";

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
    `${JSON.stringify({ schema: "codex-zero-install-v3", mode: "safe" })}\n`
  );

  const environment = { ...process.env, CODEX_ZERO_HOME: home };
  const initial = run(["mode"], environment);
  assert.equal(initial.status, 0);
  assert.equal(initial.stdout.trim(), "safe");

  const changed = run(["mode", "max-save"], environment);
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /CodexZero mode: max-save/u);
  const metadata = JSON.parse(await fs.readFile(path.join(home, "install.json"), "utf8"));
  assert.equal(metadata.schema, "codex-zero-install-v3");
  assert.equal(metadata.mode, "max-save");

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

test("Max Savings mode requires the installed bundled prompt", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-mode-missing-"));
  await fs.writeFile(
    path.join(home, "install.json"),
    `${JSON.stringify({ schema: "codex-zero-install-v3", mode: "safe" })}\n`
  );
  const result = run(
    ["mode", "max-save"],
    { ...process.env, CODEX_ZERO_HOME: home }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Max Savings prompt is missing/u);
});

test("legacy install modes are reported with their new names", async () => {
  const cases = [
    ["command-output", "safe"],
    ["full-lean", "max-save"]
  ];
  for (const [legacy, expected] of cases) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-legacy-mode-"));
    await fs.writeFile(
      path.join(home, "install.json"),
      `${JSON.stringify({ schema: "codex-zero-install-v2", mode: legacy })}\n`
    );
    const result = run(["mode"], { ...process.env, CODEX_ZERO_HOME: home });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), expected);
  }
});

test("missing install metadata defaults to Safe mode", () => {
  const home = path.join(os.tmpdir(), `codex-zero-no-metadata-${crypto.randomUUID()}`);
  const result = run(["mode"], { ...process.env, CODEX_ZERO_HOME: home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "safe");
});

test("Safe omits the prompt override while Max Savings includes it", () => {
  const safe = buildLaunchArguments(["--version"], null);
  const max = buildLaunchArguments(["--version"], "C:\\prompt path\\lean.md");
  assert.equal(safe.some((value) => value.startsWith("model_instructions_file=")), false);
  assert.equal(
    max.includes('model_instructions_file="C:\\\\prompt path\\\\lean.md"'),
    true
  );
  for (const feature of [
    "features.codex_zero_compact_exec_output=true",
    "features.codex_zero_lossless_terminal_codec=true",
    "features.codex_zero_exact_duplicate_results=true",
    "features.codex_zero_event_driven_wait=true"
  ]) {
    assert.equal(safe.includes(feature), true);
    assert.equal(max.includes(feature), true);
  }
});

function run(args, env) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: root,
    env,
    encoding: "utf8"
  });
}
