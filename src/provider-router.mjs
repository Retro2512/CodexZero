import { providerReasoning, providerEffort } from "./provider-reasoning.mjs";

export const PROVIDER_ID = "codexzero_custom";
export const MODEL_PREFIX = "custom/";

export function providerModel(provider) {
  const model = `${MODEL_PREFIX}${provider.id}`;
  const reasoning = providerReasoning(provider);
  return {
    id: model, model, displayName: provider.name, description: provider.model,
    hidden: false, isDefault: false, upgrade: null, upgradeInfo: null,
    availabilityNux: null, modelSpecialty: null,
    supportedReasoningEfforts: reasoning.efforts.map(reasoningEffort => ({ reasoningEffort,
      description: reasoningEffort === "none" ? "Default" : reasoningEffort === "xhigh" ? "Extra high" : reasoningEffort[0].toUpperCase() + reasoningEffort.slice(1) })),
    defaultReasoningEffort: reasoning.defaultEffort, inputModalities: ["text", "image"],
    supportsPersonality: false, multiAgentVersion: null,
    additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null
  };
}

export function selectedModel(params = {}) {
  return params.collaborationMode?.settings?.model ?? params.model;
}

export function findProvider(providers, model) {
  if (!model?.startsWith(MODEL_PREFIX)) return null;
  const provider = providers.find(p => `${MODEL_PREFIX}${p.id}` === model && p.enabled);
  if (!provider) throw new Error("This custom model is unavailable. Check provider settings.");
  return provider;
}

// These overrides are scoped to custom threads, never the user's global config.
export function customThreadParams(params, provider, baseUrl, token) {
  const contextWindow = provider.contextWindow ?? 32000;
  // Codex reserves 5% internally. Leave additional room for the configured output.
  const compactLimit = provider.contextWindow === undefined ? 24000 : Math.max(1,
    Math.min(Math.floor(contextWindow * .9), Math.floor(contextWindow * .95) - (provider.maxOutputTokens ?? 4096)));
  return {
    ...params,
    model: `${MODEL_PREFIX}${provider.id}`,
    modelProvider: PROVIDER_ID,
    serviceTier: null,
    config: {
      ...params.config,
      [`model_providers.${PROVIDER_ID}`]: {
        name: "Custom models", base_url: baseUrl, wire_api: "responses",
        requires_openai_auth: false, supports_websockets: false,
        experimental_bearer_token: token, request_max_retries: 0,
        stream_max_retries: 0
      },
      model_context_window: contextWindow,
      model_auto_compact_token_limit: compactLimit,
      model_reasoning_effort: providerEffort(provider, params.config?.model_reasoning_effort),
      model_reasoning_summary: "none",
      // Provider adapters expose ordinary functions rather than hosted tools.
      web_search: "disabled",
      "features.code_mode": false,
      "features.code_mode_only": false
    }
  };
}

export function customTurnParams(params, provider) {
  const result = { ...params, summary: "none", serviceTier: null, serviceTierForTurn: "default" };
  if (params.effort != null) result.effort = providerEffort(provider, params.effort);
  if (result.collaborationMode) {
    result.collaborationMode = {
      ...result.collaborationMode,
      settings: { ...result.collaborationMode.settings,
        reasoning_effort: providerEffort(provider, result.collaborationMode.settings?.reasoning_effort ?? params.effort) }
    };
  }
  return result;
}
