import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runChecks } from "../src/run-checks.mjs";

test("batched checks match the same unbatched commands", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  process.env.CODEX_ZERO_ARTIFACT_DIR = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-zero-checks-")
  );
  const configuration = JSON.parse(
    await fs.readFile(path.join(root, "fixtures", "checks.json"), "utf8")
  );
  const batched = await runChecks("fixture", { cwd: root });
  assert.equal(batched.commands.length, configuration.fixture.commands.length);

  for (const [index, command] of configuration.fixture.commands.entries()) {
    const unbatched = spawnSync(command.program, command.args, {
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat"
      }
    });
    const result = batched.commands[index];
    assert.equal(result.command, [command.program, ...command.args].join(" "));
    assert.equal(result.exitCode, unbatched.status);
    assert.equal(result.stdout.encoding, "utf8");
    assert.equal(result.stderr.encoding, "utf8");
    assert.equal(result.stdout.text, unbatched.stdout.toString("utf8"));
    assert.equal(result.stderr.text, unbatched.stderr.toString("utf8"));
  }
});

test("summary mode preserves status and full binary output in artifacts", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-summary-"));
  const previous = process.env.CODEX_ZERO_ARTIFACT_DIR;
  process.env.CODEX_ZERO_ARTIFACT_DIR = path.join(cwd, "artifacts");
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_ZERO_ARTIFACT_DIR;
    else process.env.CODEX_ZERO_ARTIFACT_DIR = previous;
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(cwd, "codexzero.checks.json"), JSON.stringify({
    verify: { commands: [{ file: process.execPath, args: ["-e",
      "process.stdout.write(Buffer.from([0,255,13,10])); process.stderr.write('failed'); process.exitCode=7"] }] }
  }));
  const result = await runChecks("verify", { cwd, summaryOnly: true });
  assert.equal(result.success, false);
  assert.equal(result.commands[0].exitCode, 7);
  assert.equal("stdout" in result.commands[0], false);
  assert.equal("stderr" in result.commands[0], false);
  assert.deepEqual(await fs.readFile(result.commands[0].artifacts.stdout.path), Buffer.from([0, 255, 13, 10]));
  assert.equal(await fs.readFile(result.commands[0].artifacts.stderr.path, "utf8"), "failed");
});

test("invalid later commands are rejected before any command runs", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-preflight-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "codexzero.checks.json"), JSON.stringify({
    verify: { commands: [{ file: process.execPath, args: ["-e", "require('fs').writeFileSync('marker','ran')"] }, null] }
  }));
  await assert.rejects(runChecks("verify", { cwd }), /Each check/);
  await assert.rejects(fs.access(path.join(cwd, "marker")), { code: "ENOENT" });
});
