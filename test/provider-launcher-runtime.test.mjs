import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { copyProviderRuntime } from "../src/provider-launcher.mjs";

test("Desktop keeps the packaged patched filename and fills missing official companions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-runtime-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "desktop/resources"), dist = path.join(root, "dist");
  await fs.mkdir(resources, { recursive: true });
  await fs.mkdir(dist);
  const sourceCore = path.join(dist, "codex-zero-core.exe");
  await fs.writeFile(sourceCore, "patched binary fixture");
  await fs.writeFile(path.join(resources, "codex.exe"), "official binary fixture");
  await fs.writeFile(path.join(resources, "codex-command-runner.exe"), "official helper");
  await fs.writeFile(path.join(resources, "codex-code-mode-host.exe"), "older helper");
  await fs.writeFile(path.join(dist, "codex-code-mode-host.exe"), "packaged helper");
  const options = { root: path.join(root, "provider-runtime"), sourceCore, platform: "win32" };
  const core = await copyProviderRuntime(path.join(root, "desktop/ChatGPT.exe"), options);
  assert.equal(path.basename(core), "codex-zero-core.exe");
  assert.equal(await fs.readFile(core, "utf8"), "patched binary fixture");
  assert.equal(await fs.readFile(path.join(path.dirname(core), "codex-command-runner.exe"), "utf8"), "official helper");
  assert.equal(await fs.readFile(path.join(path.dirname(core), "codex-code-mode-host.exe"), "utf8"), "packaged helper");
  assert.equal(await copyProviderRuntime(path.join(root, "desktop/ChatGPT.exe"), options), core);
  assert.equal(await fs.readFile(path.join(resources, "codex.exe"), "utf8"), "official binary fixture");
});

test("Mac startup selects the bundled patched runtime without using an existing stock override", async () => {
  const source = await fs.readFile(new URL("../assets/native-provider-environment.cjs", import.meta.url), "utf8");
  for (const bundled of [false, true]) {
    const environment = { CODEX_ZERO_PROVIDER_CORE: "stale stock override" };
    const resources = path.join(os.tmpdir(), "CodexZero.app/Contents/Resources");
    vm.runInNewContext(source, {
      process: { platform: "darwin", resourcesPath: resources, env: environment },
      require(name) {
        if (name === "node:fs") return { existsSync: () => bundled };
        if (name === "node:os") return { homedir: () => os.tmpdir() };
        if (name === "node:path") return path;
        throw new Error(name);
      },
    });
    assert.equal(environment.CODEX_ZERO_PROVIDER_CORE, bundled
      ? path.join(resources, "codexzero/provider-runtime/codex-zero-core")
      : path.join(resources, "codex"));
  }
});
