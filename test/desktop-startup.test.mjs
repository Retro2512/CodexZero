import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startVerifiedDesktop, verifyAppServer } from "../src/desktop-startup.mjs";

const fixture = `
const mode = process.env.FIXTURE_MODE;
if (mode === "failure") {
  console.error("fixture failed");
  process.exit(8);
}
if (mode === "timeout" || mode === "desktop-success") {
  setInterval(() => {}, 1000);
  if (mode === "desktop-success") setTimeout(() => console.error("fixture remains connected"), 300);
}
if (mode === "success") {
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", input => {
    const message = JSON.parse(input.trim());
    if (message.method !== "initialize" || message.params.clientInfo.name !== "codex-zero-startup") {
      process.exit(9);
    }
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fixture" } }) + "\\n");
  });
}
`;

test("startup probe requires an initialize response and stops its child", async (t) => {
  const script = await writeFixture(t);
  let child;
  await verifyAppServer(process.execPath, { ...process.env, FIXTURE_MODE: "success" }, {
    timeoutMs: 2000,
    spawnProcess: (_binary, _args, options) => {
      child = spawn(process.execPath, [script], options);
      return child;
    }
  });
  assert.ok(child.pid);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
});

test("startup probe reports immediate failure", async (t) => {
  const script = await writeFixture(t);
  await assert.rejects(verifyAppServer(process.execPath, {
    ...process.env, FIXTURE_MODE: "failure"
  }, {
    timeoutMs: 2000,
    spawnProcess: (_binary, _args, options) => spawn(process.execPath, [script], options)
  }), /fixture failed/u);
});

test("startup probe preserves a missing binary error", async (t) => {
  const script = await writeFixture(t);
  const missing = path.join(path.dirname(script), "missing-binary");
  await assert.rejects(verifyAppServer(missing, process.env, { timeoutMs: 200 }),
    /ENOENT/u);
});

test("startup probe times out and stops its child", async (t) => {
  const script = await writeFixture(t);
  let child;
  await assert.rejects(verifyAppServer(process.execPath, {
    ...process.env, FIXTURE_MODE: "timeout"
  }, {
    timeoutMs: 100,
    spawnProcess: (_binary, _args, options) => {
      child = spawn(process.execPath, [script], options);
      return child;
    }
  }), /initialize timed out/u);
  assert.notEqual(child.exitCode === null && child.signalCode === null, true);
});

test("Desktop startup rejects a child that exits during the verification window", async (t) => {
  const script = await writeFixture(t);
  await assert.rejects(startVerifiedDesktop(process.execPath, {
    ...process.env, FIXTURE_MODE: "failure"
  }, {
    logPath: path.join(path.dirname(script), "desktop.log"),
    startupMs: 500,
    spawnProcess: (_binary, _args, options) => spawn(process.execPath, [script], options)
  }), /fixture failed/u);
});

test("Desktop startup preserves a missing executable error", async (t) => {
  const script = await writeFixture(t);
  await assert.rejects(startVerifiedDesktop(path.join(path.dirname(script), "missing-desktop"),
    process.env, {
      logPath: path.join(path.dirname(script), "desktop.log"),
      startupMs: 200
    }), /ENOENT/u);
});

test("Desktop startup succeeds only after its child survives the verification window", async (t) => {
  const script = await writeFixture(t);
  const child = await startVerifiedDesktop(process.execPath, {
    ...process.env, FIXTURE_MODE: "desktop-success"
  }, {
    logPath: path.join(path.dirname(script), "desktop.log"),
    startupMs: 200,
    spawnProcess: (_binary, _args, options) => spawn(process.execPath, [script], options)
  });
  try {
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.match(await fs.readFile(path.join(path.dirname(script), "desktop.log"), "utf8"),
      /fixture remains connected/u);
    assert.equal(child.exitCode, null);
  } finally {
    child.ref();
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill();
    await closed;
  }
});

async function writeFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-desktop-startup-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "fixture.cjs");
  await fs.writeFile(script, fixture);
  return script;
}
