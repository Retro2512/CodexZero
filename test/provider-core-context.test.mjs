import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { patchProviderContextBytes, PROVIDER_CONTEXT_PATCH } from "../src/provider-core-context.mjs";

test("custom context patch rejects unrecognized cores without changing bytes", () => {
  const unknown = Buffer.from("an unsupported core version");
  const before = Buffer.from(unknown);
  assert.throws(() => patchProviderContextBytes(unknown), /updated custom context patch/);
  assert.deepEqual(unknown, before);
});

test("the original and patched cores expose identical subscription model catalogs", {
  skip: !process.env.CODEX_ZERO_TEST_BASE_CORE || !process.env.CODEX_ZERO_TEST_CORE,
  timeout: 30000,
}, async t => {
  async function catalog(executable) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cz-catalog-parity-"));
    const child = spawn(executable, ["app-server"], { windowsHide: true,
      env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "offline-catalog-test" }, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    const pending = new Map(); let id = 0;
    lines.on("line", line => {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
    });
    t.after(async () => {
      lines.close();
      if (child.exitCode == null) child.kill();
      await fs.rm(home, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
    await rpc("initialize", { clientInfo: { name: "catalog_parity", version: "1.0" } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const result = await rpc("model/list", {});
    const exit = new Promise(resolve => child.once("exit", resolve));
    child.stdin.end(); await exit;
    return result;
  }
  assert.deepEqual(await catalog(process.env.CODEX_ZERO_TEST_CORE), await catalog(process.env.CODEX_ZERO_TEST_BASE_CORE));
});

test("pinned context patch changes only the unknown model maximum and preserves the default", {
  skip: !process.env.CODEX_ZERO_TEST_BASE_CORE,
}, async () => {
  const source = await fs.readFile(process.env.CODEX_ZERO_TEST_BASE_CORE);
  const patched = patchProviderContextBytes(source);
  const { offset, before, after, sourceSha256 } = PROVIDER_CONTEXT_PATCH;
  assert.equal(createHash("sha256").update(source).digest("hex"), sourceSha256);
  assert.equal(patched.length, source.length);
  assert.ok(patched.subarray(0, offset).equals(source.subarray(0, offset)));
  assert.ok(patched.subarray(offset + 4).equals(source.subarray(offset + 4)));
  assert.equal(source.readUInt32LE(offset), before);
  assert.equal(patched.readUInt32LE(offset), after);
  assert.equal(patched.readUInt32LE(offset - 16), before, "Default context remains 272k");
  assert.throws(() => patchProviderContextBytes(patched), /updated custom context patch/);
});
