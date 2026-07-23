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
