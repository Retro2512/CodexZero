import test from "node:test";
import assert from "node:assert/strict";
import { providerReasoning, applyProviderReasoning } from "../src/provider-reasoning.mjs";
import { providerModel, customThreadParams, customTurnParams } from "../src/provider-router.mjs";
import { validateProviders } from "../src/provider-store.mjs";
import { normalizeResult } from "../assets/native-provider-settings.mjs";

const glm = { id: "glm", name: "GLM", model: "zai/glm-5.3-flash-uncensored", apiType: "chat", baseUrl: "https://api.arnict.com/v1" };

test("Arnict GLM exposes real effort levels without unsupported medium or off", () => {
  assert.deepEqual(providerReasoning(glm), { mode: "glm-template", efforts: ["low", "high", "max"], defaultEffort: "max" });
  assert.deepEqual(providerModel(glm).supportedReasoningEfforts.map(e => e.reasoningEffort), ["low", "high", "max"]);
  for (const effort of ["low", "high", "max"]) {
    const turn = customTurnParams({ effort, collaborationMode: { mode: "default", settings: { model: "custom/glm", reasoning_effort: effort } } }, glm);
    assert.equal(turn.effort, effort);
    assert.equal(turn.collaborationMode.settings.reasoning_effort, effort);
    const request = {};
    applyProviderReasoning(request, { reasoning: { effort } }, glm);
    assert.deepEqual(request, { reasoning_effort: effort, chat_template_kwargs: { reasoning_effort: effort, clear_thinking: true } });
  }
});

test("custom routing preserves explicit effort and does not overwrite an omitted effort", () => {
  const params = { config: { model_reasoning_effort: "low" } };
  assert.equal(customThreadParams(params, glm, "http://127.0.0.1", "test").config.model_reasoning_effort, "low");
  assert.equal(customTurnParams({}, glm).effort, undefined);
  assert.equal(customTurnParams({ effort: "medium" }, glm).effort, "max");
  assert.deepEqual(params, { config: { model_reasoning_effort: "low" } });
});

test("unknown providers stay at provider default until configured", () => {
  const unknown = { ...glm, baseUrl: "https://another.test/v1" };
  assert.equal(providerReasoning(unknown).mode, "none");
  const request = { reasoning: { effort: "none" } };
  applyProviderReasoning(request, {}, unknown);
  assert.deepEqual(request, {});
  assert.equal(providerReasoning({ ...glm, reasoningMode: "none" }).mode, "none");
});

test("reasoning maps to each API protocol", () => {
  for (const [apiType, reasoningMode, expected] of [
    ["chat", "effort", { reasoning_effort: "high" }],
    ["responses", "effort", { reasoning: { effort: "high" } }],
    ["anthropic", "anthropic", { output_config: { effort: "high" } }],
    ["chat", "glm", { reasoning_effort: "high", thinking: { type: "enabled" } }],
  ]) {
    const request = {};
    applyProviderReasoning(request, { reasoning: { effort: "high" } }, { apiType, reasoningMode });
    assert.deepEqual(request, expected);
  }
});

test("settings preserve reasoning mode and reject incompatible modes", () => {
  const [saved] = validateProviders([{ ...glm, reasoningMode: "glm-template" }]);
  assert.equal(saved.reasoningMode, "glm-template");
  assert.equal(normalizeResult({ providers: [saved] }).providers[0].reasoningMode, "glm-template");
  assert.equal(normalizeResult({ providers: [glm] }).providers[0].reasoningMode, "auto");
  for (const bad of [{ reasoningMode: "bogus" }, { reasoningMode: "anthropic" }, { reasoningMode: "glm", apiType: "responses" }]) {
    assert.throws(() => validateProviders([{ ...glm, ...bad }]));
  }
});
