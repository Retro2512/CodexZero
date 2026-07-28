import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("unattended Windows install defaults without prompting", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const packageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-zero-windows-installer-")
  );
  const promptRoot = path.join(packageRoot, "prompts");
  await fs.mkdir(promptRoot);
  await fs.writeFile(path.join(promptRoot, "codex-core-lean-v1.md"), "fixture");

  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(root, "scripts", "install.ps1"),
      "-PackageRoot",
      packageRoot,
      "-SkipMonitor"
    ],
    { encoding: "utf8" }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /codex-zero-core\.exe is missing/u);
  assert.doesNotMatch(output, /null-valued|NonInteractive mode/u);
  assert.match(
    await fs.readFile(path.join(root, "scripts", "install.ps1"), "utf8"),
    /else \{\s+'standard'\s+\}/u
  );
});
