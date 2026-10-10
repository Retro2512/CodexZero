import test from "node:test";
import assert from "node:assert/strict";
import { providerModel, customThreadParams, customTurnParams, findProvider } from "../src/provider-router.mjs";
import { verifyCoreCompatibility } from "../src/core-compatibility.mjs";

test("custom picker entries and routing do not replace subscription defaults", () => {
  const provider = { id: "claude", name: "My Claude", model: "configured-model", enabled: true };
  const model = providerModel(provider);
  assert.equal(model.isDefault, false);
  assert.equal(model.model, "custom/claude");
  assert.equal(findProvider([provider], "gpt-5.5"), null);
  assert.throws(() => findProvider([provider], "custom/missing"));
  const input = { model: "custom/claude", approvalPolicy: "on-request", config: { personality: "pragmatic" } };
  const routed = customThreadParams(input, provider, "http://127.0.0.1:1234/v1", "local-token");
  assert.equal(routed.approvalPolicy, input.approvalPolicy);
  assert.equal(routed.config.personality, "pragmatic");
  assert.equal(routed.config["model_providers.codexzero_custom"].requires_openai_auth, false);
  assert.equal(input.modelProvider, undefined);
  assert.equal(customTurnParams({ model: model.model }).serviceTier, null);
});

test("GLM compacts at 320000 tokens without changing its context or effort", () => {
  const glm = { id: "glm", apiType: "chat", model: "zai/glm-5.3-flash-uncensored",
    baseUrl: "https://api.arnict.com/v1", contextWindow: 1048576, maxOutputTokens: 131072 };
  const input = { config: { model_reasoning_effort: "high", personality: "pragmatic" } };
  const routed = customThreadParams(input, glm, "http://localhost/v1", "local-token");
  assert.equal(routed.config.model_auto_compact_token_limit, 320000);
  assert.equal(routed.config.model_context_window, 1048576);
  assert.equal(routed.config.model_reasoning_effort, "high");
  assert.deepEqual(input.config, { model_reasoning_effort: "high", personality: "pragmatic" });
  const smaller = customThreadParams({}, { ...glm, contextWindow: 100000, maxOutputTokens: 10000 }, "http://localhost/v1", "local-token");
  assert.equal(smaller.config.model_auto_compact_token_limit, 85000);
  const other = customThreadParams({}, { ...glm, model: "another-coder" }, "http://localhost/v1", "local-token");
  assert.equal(other.config.model_auto_compact_token_limit, 865075);
});

test("real Codex core can select a custom model and complete a tool round trip", {
  // The verifier keeps its own 90s deadline. Leave time for bounded cleanup
  // so a timeout reports the verifier failure rather than cancelling the test.
  skip: !process.env.CODEX_ZERO_TEST_CORE, timeout: 120000,
}, async () => {
  const started = Date.now();
  await verifyCoreCompatibility(process.env.CODEX_ZERO_TEST_CORE, {
    baseline: process.env.CODEX_ZERO_TEST_BASELINE,
    launcher: process.env.CODEX_ZERO_TEST_LAUNCHER,
    trace: process.env.CI ? message => console.log(`Compatibility +${Date.now() - started}ms: ${message}`) : undefined,
  });
});
