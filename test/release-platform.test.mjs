import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("Unix bootstrap selects the operating system and validates release pins without downloading", {
  skip: process.platform === "win32"
}, async (t) => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-platform-"));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  await fs.writeFile(path.join(bin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) printf '%s\\n' \"$TEST_OS\" ;; -m) printf '%s\\n' \"$TEST_ARCH\" ;; esac\n", { mode: 0o755 });
  const run = (system, arch, version = "latest") => spawnSync("sh", [path.join(root, "scripts/bootstrap.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TEST_OS: system,
      TEST_ARCH: arch,
      CODEX_ZERO_VERSION: version,
      CODEX_ZERO_BOOTSTRAP_PLAN: "1"
    }
  });
  assert.match(run("Darwin", "arm64").stdout, /releases\/latest\/download\/codex-zero-macos-arm64\.tar\.gz/);
  assert.match(run("Darwin", "x86_64").stdout, /codex-zero-macos-x64\.tar\.gz/);
  assert.match(run("Linux", "x86_64", "0.9.1").stdout, /releases\/download\/v0\.9\.1\/codex-zero-linux-x64\.tar\.gz/);
  assert.match(run("Linux", "x86_64", "v0.9.1-rc.1").stdout, /releases\/download\/v0\.9\.1-rc\.1\/codex-zero-linux-x64\.tar\.gz/);
  assert.notEqual(run("Linux", "aarch64").status, 0);
  assert.notEqual(run("Linux", "x86_64", "../latest").status, 0);
});

test("Windows bootstrap validates release pins without downloading", { skip: process.platform !== "win32" }, () => {
  const run = (version) => spawnSync("pwsh", ["-NoProfile", "-File", path.join(root, "scripts/bootstrap.ps1")], {
    encoding: "utf8",
    env: { ...process.env, CODEX_ZERO_VERSION: version, CODEX_ZERO_BOOTSTRAP_PLAN: "1" }
  });
  const pinned = run("0.9.1");
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(pinned.stdout, /releases\/download\/v0\.9\.1\/CodexZero-Setup-windows-x64\.exe/);
  assert.match(run("v0.9.1-rc.1").stdout, /releases\/download\/v0\.9\.1-rc\.1\/CodexZero-Setup-windows-x64\.exe/);
  const latest = run("latest");
  assert.equal(latest.status, 0, latest.stderr);
  assert.match(latest.stdout, /releases\/latest\/download\/CodexZero-Setup-windows-x64\.exe/);
  assert.equal(run("../latest").status, 1);
});

test("Unix installer repairs only its selected artifact store after copying the new command", async () => {
  const script = await fs.readFile(path.join(root, "scripts/install.sh"), "utf8");
  const copy = script.indexOf('cp -R "$PACKAGE_ROOT/bin"');
  const repair = script.indexOf('artifacts repair --json >/dev/null');
  assert.ok(copy >= 0 && repair > copy);
  assert.match(script, /CODEX_HOME="\$CODEX_HOME" CODEX_ZERO_HOME="\$INSTALL_ROOT"/);
  assert.match(script, /CODEX_ZERO_ARTIFACT_DIR="\$INSTALL_ROOT\/artifacts"/);
  assert.match(script, /\[ -L "\$CODEX_HOME" \] \|\| \[ -L "\$INSTALL_ROOT" \]/);
});
