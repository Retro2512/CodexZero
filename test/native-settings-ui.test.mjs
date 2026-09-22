import assert from "node:assert/strict";
import test from "node:test";

import { cacheCostLabels, normalizeSnapshot } from "../assets/native-cache-ui.mjs";
import { normalizeResult, serializePricing, serializeContextWindow } from "../assets/native-provider-settings.mjs";
import { validateProviders } from "../src/provider-store.mjs";

test("older provider settings remain saveable without inventing a context limit", () => {
  const legacy = { id: "legacy", name: "Legacy", apiType: "chat", baseUrl: "https://example.com/v1",
    model: "example", maxOutputTokens: 131072, enabled: true };
  const [draft] = normalizeResult({ providers: [legacy] }).providers;
  assert.equal(draft.contextWindow, "");
  const [saved] = validateProviders([{ ...legacy, contextWindow: serializeContextWindow(draft.contextWindow) }]);
  assert.equal(saved.contextWindow, undefined);
  assert.equal(saved.maxOutputTokens, legacy.maxOutputTokens);
  assert.equal(serializeContextWindow("262144"), 262144);
});

test("provider UI preserves configured context and pricing", () => {
  const result = normalizeResult({
    providers: [{
      id: "custom",
      name: "Custom",
      contextWindow: 128000,
      pricing: { input: 0.14, read: 0.014, output: 0.28, write: 0.18, label: "DeepInfra equivalent" },
    }],
  });

  assert.equal(result.providers[0].contextWindow, 128000);
  assert.deepEqual(result.providers[0].pricing, {
    input: 0.14,
    read: 0.014,
    output: 0.28,
    write: 0.18,
    label: "DeepInfra equivalent",
  });
});

test("provider UI omits wholly blank pricing and retains zero rates", () => {
  assert.equal(serializePricing({ input: "", read: "", output: "", write: "", label: "" }), undefined);
  assert.deepEqual(serializePricing({ input: 0, read: 0, output: 0, write: "", label: "  Free tier  " }), {
    input: 0,
    read: 0,
    output: 0,
    label: "Free tier",
  });
});

test("cache snapshot preserves cost labels and keep warm support", () => {
  const snapshot = normalizeSnapshot({
    cost: { usd: 0.12, uncachedUsd: 0.4, partial: true, label: "  DeepInfra equivalent  " },
    keepWarmSupported: false,
  });

  assert.equal(snapshot.cost.label, "DeepInfra equivalent");
  assert.equal(snapshot.keepWarmSupported, false);
  assert.deepEqual(cacheCostLabels(snapshot.cost), {
    displayed: "DeepInfra equivalent · partial",
    accessible: "DeepInfra equivalent · partial",
  });
  assert.equal(normalizeSnapshot({}).keepWarmSupported, true);
});

test("cache labels retain the original fallback behavior", () => {
  assert.deepEqual(cacheCostLabels({ label: "", partial: true }), {
    displayed: "API equivalent · partial",
    accessible: "API equivalent",
  });
});
