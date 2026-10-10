import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderUsageLedger } from "../src/provider-usage-ledger.mjs";

const timestamp = "2026-09-30T12:00:00.000Z";
const usage = {
  input_tokens: 1_000_000,
  input_tokens_details: { cached_tokens: 600_000, cache_write_tokens: 200_000 },
  output_tokens: 100_000,
  output_tokens_details: { reasoning_tokens: 30_000 },
  total_tokens: 1_100_000,
};
const base = {
  timestamp, requestId: "req_123", attempt: 1, providerId: "glm", apiType: "chat",
  threadId: "0199f6c4-a982-7ac4-918c-805466b2bc47", status: "completed", latencyMs: 125,
  usageKnown: true, usage,
};

async function temporaryHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cz-provider-ledger-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function lines(home) {
  return (await fs.readFile(path.join(home, "provider-usage.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
}

test("writes only validated metadata with exact cache write pricing", async (t) => {
  const home = await temporaryHome(t);
  const ledger = createProviderUsageLedger({ home });
  const requestMetrics = { messageCount: 3, toolCount: 2, toolSchemaBytes: 50,
    messageBytes: { developer: 1, user: 2, assistant: 3, tool: 4, prompt: "private" }, prompt: "private" };
  await ledger.recordAttempt({ ...base, includedInCoreUsage: false, requestMetrics,
    pricing: { input: 2, read: .5, write: 3, output: 8 },
    apiKey: "secret", headers: { authorization: "Bearer secret" }, prompt: "private", toolArguments: "private" });
  const [row] = await lines(home);
  assert.deepEqual(Object.keys(row), ["schemaVersion", "timestamp", "requestId", "attempt", "providerId", "apiType",
    "threadId", "status", "latencyMs", "usageKnown", "usage", "includedInCoreUsage", "requestMetrics",
    "estimatedCostUsd", "estimatedUncachedCostUsd"]);
  assert.deepEqual(row.usage, usage);
  assert.equal(row.includedInCoreUsage, false);
  assert.deepEqual(row.requestMetrics, { messageCount: 3, toolCount: 2, toolSchemaBytes: 50,
    messageBytes: { developer: 1, user: 2, assistant: 3, tool: 4 } });
  assert.equal(row.estimatedCostUsd, 2.1);
  assert.equal(row.estimatedUncachedCostUsd, 2.8);
  assert.doesNotMatch(JSON.stringify(row), /secret|private|authorization|pricing|prompt|toolArguments/);
  if (process.platform !== "win32") assert.equal((await fs.stat(path.join(home, "provider-usage.jsonl"))).mode & 0o777, 0o600);
});

test("unknown usage and missing rates retain null estimates", async (t) => {
  const home = await temporaryHome(t);
  const ledger = createProviderUsageLedger({ environment: { CODEX_ZERO_HOME: home } });
  await ledger.recordAttempt({ ...base, requestId: "unknown", usageKnown: false, usage: null, pricing: { input: 1, read: 1, output: 1 } });
  await ledger.recordAttempt({ ...base, requestId: "unpriced" });
  await ledger.recordAttempt({ ...base, requestId: "bad_price", pricing: { input: 1, read: -1, output: 1 } });
  const rows = await lines(home);
  assert.deepEqual(rows.map((row) => row.estimatedCostUsd), [null, null, null]);
  assert.deepEqual(rows.map((row) => row.estimatedUncachedCostUsd), [null, null, null]);
  assert.equal(rows[0].usage, null);
  assert.equal(rows[0].usageKnown, false);
  assert.equal(rows[0].includedInCoreUsage, null);
  assert.equal(rows[0].requestMetrics, null);
});

test("missing write rate uses input rate for cache writes", async (t) => {
  const home = await temporaryHome(t);
  const ledger = createProviderUsageLedger({ home });
  await ledger.recordAttempt({ ...base, pricing: { input: 2, read: .5, output: 8 } });
  assert.equal((await lines(home))[0].estimatedCostUsd, 1.9);
});

test("concurrent calls append complete independent lines", async (t) => {
  const home = await temporaryHome(t);
  const ledger = createProviderUsageLedger({ home });
  await Promise.all(Array.from({ length: 60 }, (_, index) => ledger.recordAttempt({ ...base, requestId: `req_${index}`, attempt: index + 1 })));
  const rows = await lines(home);
  assert.equal(rows.length, 60);
  assert.deepEqual(rows.map((row) => row.requestId), Array.from({ length: 60 }, (_, index) => `req_${index}`));
});

test("rejects invalid fields without appending or persisting private extras", async (t) => {
  const home = await temporaryHome(t);
  const ledger = createProviderUsageLedger({ home });
  for (const bad of [
    { attempt: 0 }, { attempt: 1.2 }, { latencyMs: -1 }, { requestId: "prompt text" },
    { providerId: "custom/glm" }, { apiType: "other" }, { status: "pending" },
    { threadId: "not-a-uuid" }, { usageKnown: "true" }, { usageKnown: false },
    { includedInCoreUsage: "true" },
    { requestMetrics: { messageCount: 1, toolCount: 0, toolSchemaBytes: 0,
      messageBytes: { developer: 0, user: 0, assistant: 0, tool: -1 } } },
    { usage: { ...usage, total_tokens: 1 } },
    { usage: { ...usage, input_tokens_details: { cached_tokens: 900_000, cache_write_tokens: 200_000 } } },
    { timestamp: "yesterday" },
  ]) {
    await assert.rejects(() => ledger.recordAttempt({ ...base, ...bad }));
  }
  await assert.rejects(fs.stat(path.join(home, "provider-usage.jsonl")), { code: "ENOENT" });
});

test("append failures reject the caller", async (t) => {
  const home = await temporaryHome(t);
  await fs.mkdir(path.join(home, "provider-usage.jsonl"));
  const ledger = createProviderUsageLedger({ home });
  await assert.rejects(ledger.recordAttempt(base));
});
