export const PROVIDER_ID = "codexzero_custom";
export const MODEL_PREFIX = "custom/";

export function providerModel(provider) {
  const model = `${MODEL_PREFIX}${provider.id}`;
  return {
    id: model, model, displayName: provider.name, description: provider.model,
    hidden: false, isDefault: false, upgrade: null, upgradeInfo: null,
    availabilityNux: null, modelSpecialty: null,
    supportedReasoningEfforts: [{ reasoningEffort: "none", description: "Default" }],
    defaultReasoningEffort: "none", inputModalities: ["text", "image"],
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
      model_context_window: 32000,
      model_auto_compact_token_limit: 24000,
      model_reasoning_effort: "none",
      model_reasoning_summary: "none",
      // Provider adapters expose ordinary functions rather than hosted tools.
      web_search: "disabled",
      "features.code_mode": false,
      "features.code_mode_only": false
    }
  };
}

export function customTurnParams(params) {
  const result = { ...params, effort: "none", summary: "none", serviceTier: null, serviceTierForTurn: "default" };
  if (result.collaborationMode) {
    result.collaborationMode = {
      ...result.collaborationMode,
      settings: { ...result.collaborationMode.settings, reasoning_effort: "none" }
    };
  }
  return result;
}
