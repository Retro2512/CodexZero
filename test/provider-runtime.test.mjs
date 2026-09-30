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
