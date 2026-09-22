import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateProviders, saveProviders } from "../src/provider-store.mjs";
import { readProviderPricing, recordProviderUsageVersion } from "../src/provider-pricing.mjs";
import { customThreadParams } from "../src/provider-router.mjs";
import { priceUsage, warmth, shouldKeepWarm } from "../src/cache-accounting.mjs";
import { readCacheSnapshot } from "../src/cache-service.mjs";

const base = { id: "glm", name: "GLM", model: "test-glm", apiType: "chat", baseUrl: "http://127.0.0.1:1234/v1", maxOutputTokens: 131072 };
const pricing = { input: .075, read: .015, output: .25, label: "DeepInfra equivalent" };
const provider = { ...base, contextWindow: 1048576, pricing };
const usage = { input_tokens: 1000000, cached_input_tokens: 800000, output_tokens: 100000 };

test("provider context and optional rates round trip without changing defaults", () => {
  assert.equal(validateProviders([base])[0].contextWindow, undefined);
  assert.equal(validateProviders([base])[0].pricing, undefined);
  const normalized = validateProviders([provider])[0];
  assert.equal(normalized.contextWindow, 1048576);
  assert.deepEqual(normalized.pricing, pricing);
  const route = customThreadParams({}, normalized, "http://127.0.0.1:42", "test");
  assert.equal(route.config.model_context_window, 1048576);
  assert.equal(route.config.model_auto_compact_token_limit, 865075);
  const defaults = customThreadParams({}, base, "http://127.0.0.1:42", "test");
  assert.equal(defaults.config.model_context_window, 32000);
  assert.equal(defaults.config.model_auto_compact_token_limit, 24000);
});

test("provider rates and context reject incomplete and invalid values", () => {
  for (const contextWindow of [null, "1048576", 0, 1023, 131072, 10000001, Infinity, 200000.5]) {
    assert.throws(() => validateProviders([{ ...base, contextWindow }]));
  }
  for (const invalid of [null, [], {}, { input: 1, read: 1 }, { ...pricing, input: -1 },
    { ...pricing, read: "0" }, { ...pricing, output: Infinity }, { ...pricing, write: NaN },
    { ...pricing, label: "" }, { ...pricing, label: "a".repeat(81) }, { ...pricing, unknown: 1 }]) {
    assert.throws(() => validateProviders([{ ...base, pricing: invalid }]));
  }
  assert.deepEqual(validateProviders([{ ...base, pricing: { input: 0, read: 0, output: 0 } }])[0].pricing,
    { input: 0, read: 0, output: 0 });
});

test("custom pricing replays saved usage when settings change without inventing cache retention", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-custom-pricing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "providers");
  await saveProviders([provider], home);
  const prices = await readProviderPricing(home);
  assert.equal(prices["custom/glm"].write, .075);
  assert.equal(prices["test-glm"], undefined);
  const cost = priceUsage("custom/glm", usage, null, prices);
  assert.ok(Math.abs(cost.usd - .052) < 1e-12);
  assert.equal(cost.uncachedUsd, .1);
  assert.equal(cost.label, pricing.label);
  assert.equal(priceUsage("custom/glm", usage), null);
  assert.deepEqual(priceUsage("gpt-5.5", usage, null, prices), priceUsage("gpt-5.5", usage));
  assert.equal(warmth({ model: "custom/glm", lastCacheAt: Date.now() }).state, "unknown");
  assert.equal(shouldKeepWarm({ id: "task", model: "custom/glm", lastCacheAt: Date.now() - 60000,
    lastUserAt: Date.now() - 120000 }, { enabled: true, minutes: 30 }), false);

  const id = "custom_cost_replay";
  await fs.mkdir(path.join(root, "sessions"));
  const timestamp = new Date().toISOString();
  await fs.writeFile(path.join(root, "sessions", `rollout-${id}.jsonl`), [
    { type: "session_meta", payload: { id }, timestamp },
    { type: "turn_context", payload: { model: "custom/glm" }, timestamp },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage, last_token_usage: usage } }, timestamp }
  ].map(r => JSON.stringify(r) + "\n").join(""));
  const snapshot = await readCacheSnapshot(id, home);
  assert.equal(snapshot.keepWarmSupported, false);
  assert.equal(snapshot.cost.label, pricing.label);
  assert.equal(snapshot.cost.usd, cost.usd);
  assert.equal(snapshot.cost.partial, false);
  await saveProviders([{ ...provider, pricing: { ...pricing, input: .125, read: .05, output: .5, label: "API estimate" } }], home);
  const repriced = await readCacheSnapshot(id, home);
  assert.ok(Math.abs(repriced.cost.usd - .115) < 1e-12);
  assert.equal(repriced.cost.label, "API estimate");
  await new Promise(resolve => setTimeout(resolve, 5));
  await recordProviderUsageVersion(home);
  const version = await fs.readFile(path.join(home, "provider-usage-version.json"), "utf8");
  await recordProviderUsageVersion(home);
  assert.equal(await fs.readFile(path.join(home, "provider-usage-version.json"), "utf8"), version);
  const legacy = await readCacheSnapshot(id, home);
  assert.equal(legacy.cost.partial, true, "Old adapters did not retain cache counts, so history is an incomplete estimate");
  assert.equal(legacy.cost.usd, repriced.cost.usd);
});
