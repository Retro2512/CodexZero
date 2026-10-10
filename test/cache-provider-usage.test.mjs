import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readCacheSnapshot } from "../src/cache-service.mjs";
import { createProviderUsageLedger } from "../src/provider-usage-ledger.mjs";

async function fixture(t, baseCost = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-provider-cost-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "codexzero"), threadId = randomUUID();
  await fs.mkdir(path.join(home, "context-cache"), { recursive: true });
  await fs.writeFile(path.join(home, "context-cache", `${threadId}.json`), JSON.stringify({
    model: "custom/glm", requests: 1, pricedRequests: 1,
    cost: { usd: baseCost, uncachedUsd: baseCost, partial: false },
  }));
  const ledger = createProviderUsageLedger({ home });
  const record = { requestId: "cost_probe", attempt: 1, providerId: "glm", apiType: "chat", threadId,
    status: "completed", latencyMs: 1, usageKnown: true,
    usage: { input_tokens: 1000000, input_tokens_details: { cached_tokens: 900000, cache_write_tokens: 0 },
      output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1000100 },
    pricing: { input: .125, read: .05, output: .5 } };
  return { home, threadId, ledger, record };
}

test("cost display includes discovery and failed attempts without rebilling the final core reply", async t => {
  const { home, threadId, ledger, record } = await fixture(t);
  await ledger.recordAttempt({ ...record, includedInCoreUsage: false });
  await ledger.recordAttempt({ ...record, attempt: 2, includedInCoreUsage: true });
  let snapshot = await readCacheSnapshot(threadId, home);
  assert.ok(Math.abs(snapshot.cost.usd - 1.05755) < 1e-12);
  assert.ok(Math.abs(snapshot.cost.uncachedUsd - 1.12505) < 1e-12);
  assert.equal(snapshot.cost.partial, false);
  assert.equal(snapshot.keepWarmSupported, false);
  assert.deepEqual((await readCacheSnapshot(threadId, home)).cost, snapshot.cost);
  await ledger.recordAttempt({ ...record, requestId: "failed_request", status: "output_limit", includedInCoreUsage: false });
  snapshot = await readCacheSnapshot(threadId, home);
  assert.ok(Math.abs(snapshot.cost.usd - 1.1151) < 1e-12);
});

test("unknown provider usage does not appear as a zero bill", async t => {
  const { home, threadId, ledger, record } = await fixture(t, 0);
  await ledger.recordAttempt({ ...record, usageKnown: false, usage: null, includedInCoreUsage: false });
  const { cost } = await readCacheSnapshot(threadId, home);
  assert.equal(cost.usd, null);
  assert.equal(cost.uncachedUsd, null);
  assert.equal(cost.partial, true);
});

test("unavailable extra usage keeps known historical cost as a partial estimate", async t => {
  const { home, threadId, ledger, record } = await fixture(t);
  await ledger.recordAttempt({ ...record, usageKnown: false, usage: null, includedInCoreUsage: false });
  const { cost } = await readCacheSnapshot(threadId, home);
  assert.equal(cost.usd, 1);
  assert.equal(cost.partial, true);
});

test("session totals include supplemental requests once even without pricing", async t => {
  const { home, threadId, ledger, record } = await fixture(t);
  const file = path.join(home, "context-cache", `${threadId}.json`);
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  persisted.sessionStats = { turns: 1, modelSteps: 1, inputTokens: 1000, outputTokens: 100,
    cachedInputTokens: 800, totalTokens: 1100, partial: false, llmTimeMs: 2000, tokensPerSecond: 50 };
  await fs.writeFile(file, JSON.stringify(persisted));
  await ledger.recordAttempt({ ...record, pricing: null, includedInCoreUsage: false });
  await ledger.recordAttempt({ ...record, attempt: 2, includedInCoreUsage: true });
  const first = await readCacheSnapshot(threadId, home);
  assert.equal(first.sessionStats.totalTokens, 1001200);
  assert.equal(first.sessionStats.modelSteps, 2);
  assert.equal(first.sessionStats.cachedInputTokens, 900800);
  assert.equal(first.sessionStats.cacheHitRate, 900800 / 1001000);
  assert.equal(first.sessionStats.tokensPerSecond, 50);
  assert.deepEqual((await readCacheSnapshot(threadId, home)).sessionStats, first.sessionStats);
});
