const STYLES = `
.czps, .czps * { box-sizing: border-box; }
.czps { color: inherit; font: inherit; padding: 2px 0 12px; }
.czps button, .czps input, .czps select { color: inherit; font: inherit; }
.czps button { cursor: pointer; }
.czps button:disabled, .czps input:disabled, .czps select:disabled { cursor: default; opacity: .55; }
.czps-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; margin: 2px 0 14px; }
.czps-add { display: flex; flex-wrap: wrap; gap: 8px; }
.czps-button { min-height: 32px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px; padding: 5px 10px; background: transparent; }
.czps-button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 6%, transparent); }
.czps-button:focus-visible, .czps-summary:focus-visible, .czps-input:focus-visible, .czps-select:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.czps-primary { border-color: color-mix(in srgb, currentColor 35%, transparent); font-weight: 600; }
.czps-status { min-height: 18px; margin: 0; font-size: 12px; }
.czps-status[data-kind="error"] { color: var(--color-text-danger, #c43b3b); }
.czps-status[data-kind="success"] { color: var(--color-text-success, #27834f); }
.czps-list { display: grid; gap: 8px; }
.czps-empty { margin: 14px 0; opacity: .68; }
.czps-provider { border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.czps-provider:last-child { border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.czps-summary { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 10px 2px; cursor: pointer; list-style: none; }
.czps-summary::-webkit-details-marker { display: none; }
.czps-summary::before { content: "›"; display: inline-block; width: 12px; opacity: .55; transform-origin: center; transition: transform 120ms ease; }
.czps-provider[open] > .czps-summary::before { transform: rotate(90deg); }
.czps-summary-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.czps-summary-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .62; font-size: 12px; }
.czps-summary-edit { margin-left: auto; opacity: .62; font-size: 12px; }
.czps-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; border: 0; margin: 0; padding: 6px 2px 18px 26px; }
.czps-field { display: grid; align-content: start; gap: 6px; min-width: 0; font-size: 12px; font-weight: 600; }
.czps-wide { grid-column: 1 / -1; }
.czps-label-line { display: flex; align-items: center; gap: 7px; min-height: 18px; }
.czps-badge { border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 999px; padding: 1px 6px; opacity: .72; font-size: 10px; font-weight: 600; }
.czps-input, .czps-select { width: 100%; min-height: 34px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 6px; padding: 6px 8px; background: color-mix(in srgb, currentColor 3%, transparent); }
.czps-input:invalid:not(:focus) { border-color: var(--color-border-danger, #b94747); }
.czps-advanced { grid-column: 1 / -1; margin-top: 2px; }
.czps-advanced > summary { width: max-content; cursor: pointer; font-size: 12px; font-weight: 600; }
.czps-advanced-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; margin-top: 14px; }
.czps-pricing { grid-column: 1 / -1; }
.czps-pricing > summary { width: max-content; cursor: pointer; font-size: 12px; font-weight: 600; }
.czps-pricing-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; margin-top: 14px; }
.czps-check { display: flex; align-items: center; gap: 8px; min-height: 34px; font-size: 12px; font-weight: 600; }
.czps-check input { width: 16px; height: 16px; margin: 0; accent-color: currentColor; }
.czps-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; padding-top: 2px; }
.czps-remove { color: var(--color-text-danger, #c43b3b); }
@media (max-width: 640px) {
  .czps-fields, .czps-advanced-grid, .czps-pricing-grid { grid-template-columns: 1fr; }
  .czps-wide, .czps-advanced, .czps-actions { grid-column: auto; }
  .czps-summary-meta { display: none; }
  .czps-fields { padding-left: 2px; }
}
`;

const API_TYPES = new Set(["responses", "chat", "anthropic"]);

function text(value, maximum = 2048) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function positiveInteger(value, fallback = 4096) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 1000000 ? number : fallback;
}

function contextWindow(value, fallback = 32000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1024 && number <= 10000000 ? number : fallback;
}

export function serializeContextWindow(value) {
  return value === "" || value === undefined ? undefined : contextWindow(value);
}

function price(value) {
  const number = Number(value);
  return value !== "" && Number.isFinite(number) && number >= 0 ? number : null;
}

function pricingDraft(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    input: price(source.input) ?? "",
    read: price(source.read) ?? "",
    output: price(source.output) ?? "",
    write: price(source.write) ?? "",
    label: text(source.label, 80),
  };
}

function hasPricing(value) {
  return ["input", "read", "output", "write", "label"].some((field) => value[field] !== "");
}

export function serializePricing(value) {
  const draft = pricingDraft(value);
  if (!hasPricing(draft)) return undefined;
  return {
    input: price(draft.input),
    read: price(draft.read),
    output: price(draft.output),
    ...(draft.write === "" ? {} : { write: price(draft.write) }),
    ...(draft.label.trim() ? { label: text(draft.label.trim(), 80) } : {}),
  };
}

function identifierSource(value) {
  return text(value, 100)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "provider";
}

export function normalizeResult(result) {
  if (!result || !Array.isArray(result.providers)) throw new Error("Invalid provider result");

  const used = new Set();
  const providers = result.providers.map((raw, index) => {
    const provider = raw && typeof raw === "object" ? raw : {};
    const suppliedId = text(provider.id, 100).trim();
    const base = suppliedId || identifierSource(provider.name || `provider_${index + 1}`);
    let id = base;
    let suffix = 2;
    while (used.has(id.toLowerCase())) id = `${base}_${suffix++}`;
    used.add(id.toLowerCase());
    return {
      id,
      name: text(provider.name, 100),
      apiType: API_TYPES.has(provider.apiType) ? provider.apiType : "responses",
      baseUrl: text(provider.baseUrl),
      model: text(provider.model, 256),
      apiKeyEnv: text(provider.apiKeyEnv, 128),
      maxOutputTokens: positiveInteger(provider.maxOutputTokens),
      contextWindow: provider.contextWindow === undefined ? "" : contextWindow(provider.contextWindow),
      pricing: pricingDraft(provider.pricing),
      reasoningMode: provider.reasoningMode ?? "auto",
      enabled: provider.enabled !== false,
      apiKeyPresent: Boolean(provider.apiKeyPresent),
      directKeyPresent: Boolean(provider.directKeyPresent),
      pendingKey: "",
      clearKey: false,
    };
  });

  return { providers, directKeySupported: Boolean(result.directKeySupported) };
}

function uniqueValue(baseValue, existing, separator) {
  if (!existing.has(baseValue.toLowerCase())) return baseValue;
  let suffix = 2;
  while (existing.has(`${baseValue}${separator}${suffix}`.toLowerCase())) suffix += 1;
  return `${baseValue}${separator}${suffix}`;
}

export function createProviderSettings(React, jsxRuntime, Section) {
  void jsxRuntime;
  const h = React.createElement;
  const { useEffect, useId, useMemo, useState } = React;

  function LocalProviderSettings() {
    const formId = useId();
    const [providers, setProviders] = useState([]);
    const [directKeySupported, setDirectKeySupported] = useState(false);
    const [removedKeyIds, setRemovedKeyIds] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ text: "", kind: "" });

    useEffect(() => {
      let active = true;
      const bridge = globalThis.window && globalThis.window.codexZeroProviders;
      if (!bridge || typeof bridge.read !== "function") {
        setLoading(false);
        setMessage({ text: "Could not load providers", kind: "error" });
        return () => { active = false; };
      }

      Promise.resolve()
        .then(() => bridge.read())
        .then((result) => {
          if (!active) return;
          const normalized = normalizeResult(result);
          setProviders(normalized.providers);
          setDirectKeySupported(normalized.directKeySupported);
          setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setLoading(false);
          setMessage({ text: "Could not load providers", kind: "error" });
        });

      return () => { active = false; };
    }, []);

    const names = useMemo(() => new Set(providers.map((provider) => provider.name.trim().toLowerCase()).filter(Boolean)), [providers]);
    const ids = useMemo(() => new Set([...providers.map((provider) => provider.id), ...removedKeyIds]), [providers, removedKeyIds]);

    function clearMessage() {
      setMessage((current) => current.text ? { text: "", kind: "" } : current);
    }

    function updateProvider(index, field, value) {
      clearMessage();
      setProviders((current) => current.map((provider, providerIndex) => {
        if (providerIndex !== index) return provider;
        if (field === "pendingKey") return { ...provider, pendingKey: value, clearKey: value ? false : provider.clearKey };
        if (field === "apiType") return { ...provider, apiType: value, reasoningMode: "auto" };
        return { ...provider, [field]: value };
      }));
    }

    function addProvider(kind) {
      const presets = {
        claude: { name: "Claude", apiType: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
        zai: { name: "Z.ai coding", apiType: "chat", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
        custom: { name: "Custom", apiType: "responses", baseUrl: "" },
      };
      const preset = presets[kind] || presets.custom;
      const name = uniqueValue(preset.name, names, " ");
      const id = uniqueValue(identifierSource(name), new Set([...ids].map((value) => value.toLowerCase())), "_");
      clearMessage();
      setProviders((current) => [...current, {
        id,
        name,
        apiType: preset.apiType,
        baseUrl: preset.baseUrl,
        model: "",
        apiKeyEnv: "",
        maxOutputTokens: 4096,
        contextWindow: 32000,
        pricing: pricingDraft(),
        enabled: true,
        apiKeyPresent: false,
        directKeyPresent: false,
        pendingKey: "",
        clearKey: false,
        added: true,
      }]);
    }

    function removeProvider(index) {
      clearMessage();
      setProviders((current) => {
        const provider = current[index];
        if (provider && provider.directKeyPresent) {
          setRemovedKeyIds((removed) => removed.includes(provider.id) ? removed : [...removed, provider.id]);
        }
        return current.filter((_, providerIndex) => providerIndex !== index);
      });
    }

    function updatePricing(index, field, value) {
      clearMessage();
      setProviders((current) => current.map((provider, providerIndex) => providerIndex === index
        ? { ...provider, pricing: { ...provider.pricing, [field]: value } }
        : provider));
    }

    async function save(event) {
      event.preventDefault();
      if (loading || saving) return;

      const trimmedNames = providers.map((provider) => provider.name.trim().toLowerCase());
      if (new Set(trimmedNames).size !== trimmedNames.length) {
        setMessage({ text: "Names must be unique", kind: "error" });
        return;
      }

      const bridge = globalThis.window && globalThis.window.codexZeroProviders;
      if (!bridge || typeof bridge.save !== "function") {
        setMessage({ text: "Could not save changes", kind: "error" });
        return;
      }

      const keys = {};
      const clearKeys = new Set(removedKeyIds);
      const configured = providers.map((provider) => {
        if (directKeySupported && provider.pendingKey) {
          Object.defineProperty(keys, provider.id, {
            value: provider.pendingKey,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          clearKeys.delete(provider.id);
        } else if (directKeySupported && provider.clearKey) {
          clearKeys.add(provider.id);
        }
        const pricing = serializePricing(provider.pricing);
        return {
          id: text(provider.id, 100),
          name: text(provider.name.trim(), 100),
          apiType: API_TYPES.has(provider.apiType) ? provider.apiType : "responses",
          baseUrl: text(provider.baseUrl.trim()),
          model: text(provider.model.trim(), 256),
          apiKeyEnv: text(provider.apiKeyEnv.trim(), 128),
          maxOutputTokens: positiveInteger(provider.maxOutputTokens),
          contextWindow: serializeContextWindow(provider.contextWindow),
          ...(pricing ? { pricing } : {}),
          reasoningMode: provider.reasoningMode ?? "auto",
          enabled: Boolean(provider.enabled),
        };
      });

      setSaving(true);
      setMessage({ text: "", kind: "" });
      try {
        const result = await bridge.save({ providers: configured, keys, clearKeys: [...clearKeys] });
        const normalized = normalizeResult(result);
        setProviders(normalized.providers);
        setDirectKeySupported(normalized.directKeySupported);
        setRemovedKeyIds([]);
        setMessage({ text: "Saved", kind: "success" });
      } catch {
        setMessage({ text: "Could not save changes", kind: "error" });
      } finally {
        setSaving(false);
      }
    }

    function fieldLabel(label, badge) {
      return h("span", { className: "czps-label-line" },
        h("span", null, label),
        badge ? h("span", { className: "czps-badge" }, badge) : null,
      );
    }

    function renderProvider(provider, index) {
      const prefix = `${formId}-${index}`;
      const disabled = loading || saving;
      const modelSummary = provider.model || "Model not set";
      const envBadge = provider.apiKeyEnv ? (provider.apiKeyPresent ? "Available" : "Not found") : "";
      const pricingConfigured = hasPricing(provider.pricing);

      return h("details", { className: "czps-provider", key: provider.id, open: provider.added ? true : undefined },
        h("summary", { className: "czps-summary" },
          h("span", { className: "czps-summary-name" }, provider.name || "New model"),
          h("span", { className: "czps-summary-meta" }, `${modelSummary} · ${provider.apiType}`),
          h("span", { className: "czps-summary-edit" }, "Edit"),
        ),
        h("fieldset", { className: "czps-fields", disabled },
          h("label", { className: "czps-field", htmlFor: `${prefix}-name` },
            fieldLabel("Name"),
            h("input", {
              className: "czps-input", id: `${prefix}-name`, name: `${prefix}-name`, value: provider.name,
              required: true, maxLength: 100, autoComplete: "off",
              onChange: (event) => updateProvider(index, "name", event.target.value),
            }),
          ),
          h("label", { className: "czps-field", htmlFor: `${prefix}-type` },
            fieldLabel("API type"),
            h("select", {
              className: "czps-select", id: `${prefix}-type`, name: `${prefix}-type`, value: provider.apiType,
              onChange: (event) => updateProvider(index, "apiType", event.target.value),
            },
              h("option", { value: "responses" }, "Responses"),
              h("option", { value: "chat" }, "Chat"),
              h("option", { value: "anthropic" }, "Anthropic"),
            ),
          ),
          h("label", { className: "czps-field czps-wide", htmlFor: `${prefix}-url` },
            fieldLabel("Base URL"),
            h("input", {
              className: "czps-input", id: `${prefix}-url`, name: `${prefix}-url`, type: "url", value: provider.baseUrl,
              required: true, maxLength: 2048, autoComplete: "off", spellCheck: false,
              onChange: (event) => updateProvider(index, "baseUrl", event.target.value),
            }),
          ),
          h("label", { className: "czps-field", htmlFor: `${prefix}-model` },
            fieldLabel("Exact model ID"),
            h("input", {
              className: "czps-input", id: `${prefix}-model`, name: `${prefix}-model`, value: provider.model,
              required: true, maxLength: 256, autoComplete: "off", spellCheck: false,
              onChange: (event) => updateProvider(index, "model", event.target.value),
            }),
          ),
          directKeySupported ? h("label", { className: "czps-field", htmlFor: `${prefix}-key` },
            fieldLabel("API key", provider.directKeyPresent ? "Saved" : ""),
            h("input", {
              className: "czps-input", id: `${prefix}-key`, name: `${prefix}-key`, type: "password", value: provider.pendingKey,
              maxLength: 16384, autoComplete: "new-password", spellCheck: false,
              onChange: (event) => updateProvider(index, "pendingKey", event.target.value),
            }),
          ) : null,
          h("details", { className: "czps-advanced" },
            h("summary", null, "Advanced"),
            h("div", { className: "czps-advanced-grid" },
              h("label", { className: "czps-field", htmlFor: `${prefix}-reasoning` },
                fieldLabel("Reasoning"),
                h("select", {
                  className: "czps-select", id: `${prefix}-reasoning`, name: `${prefix}-reasoning`, value: provider.reasoningMode ?? "auto",
                  onChange: (event) => updateProvider(index, "reasoningMode", event.target.value),
                },
                  h("option", { value: "auto" }, "Automatic"),
                  h("option", { value: "none" }, "Provider default"),
                  ...(provider.apiType === "anthropic" ? [h("option", { value: "anthropic", key: "anthropic" }, "Claude effort")] : [
                    h("option", { value: "effort", key: "effort" }, "Low, medium, high"),
                    h("option", { value: "effort-extended", key: "extended" }, "Low, medium, high, extra high"),
                  ]),
                  ...(provider.apiType === "chat" ? [
                    h("option", { value: "glm", key: "glm" }, "GLM 5.3"),
                    h("option", { value: "glm-template", key: "glm-template" }, "GLM 5.3 template"),
                  ] : []),
                ),
              ),
              h("label", { className: "czps-field", htmlFor: `${prefix}-env` },
                fieldLabel("API key environment variable", envBadge),
                h("input", {
                  className: "czps-input", id: `${prefix}-env`, name: `${prefix}-env`, value: provider.apiKeyEnv,
                  maxLength: 128, pattern: "[A-Za-z_][A-Za-z0-9_]*", autoComplete: "off", spellCheck: false,
                  onChange: (event) => updateProvider(index, "apiKeyEnv", event.target.value),
                }),
              ),
              h("label", { className: "czps-field", htmlFor: `${prefix}-tokens` },
                fieldLabel("Maximum output tokens"),
                h("input", {
                  className: "czps-input", id: `${prefix}-tokens`, name: `${prefix}-tokens`, type: "number",
                  value: provider.maxOutputTokens, required: true, min: 1, max: 1000000, step: 1,
                  onChange: (event) => updateProvider(index, "maxOutputTokens", event.target.value),
                }),
              ),
              h("label", { className: "czps-field", htmlFor: `${prefix}-context-window` },
                fieldLabel("Context window"),
                h("input", {
                  className: "czps-input", id: `${prefix}-context-window`, name: `${prefix}-context-window`, type: "number",
                  value: provider.contextWindow, placeholder: "32000", min: 1024, max: 10000000, step: 1,
                  onChange: (event) => updateProvider(index, "contextWindow", event.target.value),
                }),
              ),
              h("details", { className: "czps-pricing", open: pricingConfigured ? true : undefined },
                h("summary", null, "Pricing (USD per 1M tokens)"),
                h("div", { className: "czps-pricing-grid" },
                  h("label", { className: "czps-field", htmlFor: `${prefix}-price-input` },
                    fieldLabel("Input"),
                    h("input", {
                      className: "czps-input", id: `${prefix}-price-input`, name: `${prefix}-price-input`, type: "number",
                      value: provider.pricing.input, required: pricingConfigured, min: 0, step: "any",
                      onChange: (event) => updatePricing(index, "input", event.target.value),
                    }),
                  ),
                  h("label", { className: "czps-field", htmlFor: `${prefix}-price-read` },
                    fieldLabel("Cached input"),
                    h("input", {
                      className: "czps-input", id: `${prefix}-price-read`, name: `${prefix}-price-read`, type: "number",
                      value: provider.pricing.read, required: pricingConfigured, min: 0, step: "any",
                      onChange: (event) => updatePricing(index, "read", event.target.value),
                    }),
                  ),
                  h("label", { className: "czps-field", htmlFor: `${prefix}-price-output` },
                    fieldLabel("Output"),
                    h("input", {
                      className: "czps-input", id: `${prefix}-price-output`, name: `${prefix}-price-output`, type: "number",
                      value: provider.pricing.output, required: pricingConfigured, min: 0, step: "any",
                      onChange: (event) => updatePricing(index, "output", event.target.value),
                    }),
                  ),
                  h("label", { className: "czps-field", htmlFor: `${prefix}-price-write` },
                    fieldLabel("Cache write"),
                    h("input", {
                      className: "czps-input", id: `${prefix}-price-write`, name: `${prefix}-price-write`, type: "number",
                      value: provider.pricing.write, min: 0, step: "any",
                      onChange: (event) => updatePricing(index, "write", event.target.value),
                    }),
                  ),
                  h("label", { className: "czps-field czps-wide", htmlFor: `${prefix}-price-label` },
                    fieldLabel("Pricing label"),
                    h("input", {
                      className: "czps-input", id: `${prefix}-price-label`, name: `${prefix}-price-label`,
                      value: provider.pricing.label, maxLength: 80, autoComplete: "off",
                      onChange: (event) => updatePricing(index, "label", event.target.value),
                    }),
                  ),
                ),
              ),
              h("label", { className: "czps-check", htmlFor: `${prefix}-enabled` },
                h("input", {
                  id: `${prefix}-enabled`, name: `${prefix}-enabled`, type: "checkbox", checked: provider.enabled,
                  onChange: (event) => updateProvider(index, "enabled", event.target.checked),
                }),
                h("span", null, "Enabled"),
              ),
              directKeySupported && provider.directKeyPresent ? h("label", { className: "czps-check", htmlFor: `${prefix}-clear` },
                h("input", {
                  id: `${prefix}-clear`, name: `${prefix}-clear`, type: "checkbox", checked: provider.clearKey,
                  onChange: (event) => updateProvider(index, "clearKey", event.target.checked),
                }),
                h("span", null, "Clear saved key"),
              ) : null,
            ),
          ),
          h("div", { className: "czps-actions" },
            h("button", { className: "czps-button czps-remove", type: "button", onClick: () => removeProvider(index) }, "Remove"),
          ),
        ),
      );
    }

    return h(Section, {},
      h(Section.Header, { title: "Custom models" }),
      h(Section.Content, {},
        h("style", null, STYLES),
        h("form", { className: "czps", onSubmit: save, "aria-busy": loading || saving },
          h("div", { className: "czps-toolbar" },
            h("div", { className: "czps-add", "aria-label": "Add custom model" },
              h("button", { className: "czps-button", type: "button", disabled: loading || saving, onClick: () => addProvider("claude") }, "Add Claude"),
              h("button", { className: "czps-button", type: "button", disabled: loading || saving, onClick: () => addProvider("zai") }, "Add Z.ai coding"),
              h("button", { className: "czps-button", type: "button", disabled: loading || saving, onClick: () => addProvider("custom") }, "Add custom"),
            ),
            h("button", { className: "czps-button czps-primary", type: "submit", disabled: loading || saving }, saving ? "Saving" : "Save changes"),
          ),
          message.text ? h("p", {
            className: "czps-status", "data-kind": message.kind,
            role: message.kind === "error" ? "alert" : "status", "aria-live": "polite",
          }, message.text) : null,
          h("div", { className: "czps-list" },
            loading ? h("p", { className: "czps-empty", role: "status" }, "Loading") : null,
            !loading && providers.length === 0 ? h("p", { className: "czps-empty" }, "No custom models") : null,
            providers.map(renderProvider),
          ),
        ),
      ),
    );
  }

  return function ProviderSettings({ hostId }) {
    return hostId === "local" ? h(LocalProviderSettings) : null;
  };
}
