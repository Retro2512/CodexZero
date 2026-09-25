import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCacheServiceClient } from "../src/cache-service-client.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-cache-worker-"));
  const home = path.join(root, "codexzero");
  const client = createCacheServiceClient({ home });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, home, client };
}

test("cache worker keeps settings, overrides, activity, and validation semantics", async t => {
  const { home, client } = await fixture(t);
  assert.equal((await client.readCacheSnapshot(null)).enabled, false);
  assert.deepEqual(await client.saveCacheSettings({ enabled: true, minutes: 12 }), { enabled: true, minutes: 12 });
  assert.equal((await client.setCacheEnabled("task_1", false)).enabled, false);
  await client.cacheActivity("task_1");
  const value = await client.readCacheSnapshot("task_1");
  assert.equal(value.settings.minutes, 12);
  assert.equal(value.override, false);
  const stored = JSON.parse(await fs.readFile(path.join(home, "context-cache", "settings.json"), "utf8"));
  assert.equal(stored.activity.task_1 > 0, true);
  assert.equal(stored.overrides.task_1, false);
  await assert.rejects(client.saveCacheSettings({ enabled: true, minutes: 0 }), TypeError);
  await assert.rejects(client.setCacheEnabled("../outside", true), TypeError);
  await assert.rejects(client.readCacheSnapshot("../outside"), TypeError);
});

test("a large rollout is parsed without blocking the caller's event loop", async t => {
  const { root, client } = await fixture(t);
  const id = "large_task";
  const sessions = path.join(root, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-${id}.jsonl`);
  const stamp = new Date().toISOString();
  const meta = JSON.stringify({ timestamp: stamp, type: "session_meta", payload: { id } }) + "\n";
  const turn = JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n";
  const filler = JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "agent_message", message: "x".repeat(90) } }) + "\n";
  const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 };
  const tokens = JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: usage, last_token_usage: usage } } }) + "\n";
  await fs.writeFile(file, meta + turn + filler.repeat(180_000) + tokens);
  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 1);
  try {
    const snapshot = await client.readCacheSnapshot(id);
    assert.equal(snapshot.settings.minutes, 30);
    assert.ok(snapshot.cost.usd > 0);
    assert.ok(ticks >= 5, `caller heartbeat only advanced ${ticks} times`);
  } finally { clearInterval(heartbeat); }
});

test("client limits pending requests and closes the worker", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-cache-worker-"));
  const client = createCacheServiceClient({ home: path.join(root, "codexzero"), maxPending: 1 });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  const first = client.readCacheSnapshot(null);
  await assert.rejects(client.readCacheSnapshot(null), /busy/);
  await first;
  await client.close();
  await assert.rejects(client.readCacheSnapshot(null), /closed/);
});

test("a timed out worker rejects its pending request without parsing on the caller", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-cache-worker-"));
  const client = createCacheServiceClient({ home: path.join(root, "codexzero"), timeoutMs: 1 });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(client.readCacheSnapshot(null), /timed out/);
});
