export const REASONING_MODES = new Set(["auto", "none", "effort", "effort-extended", "glm", "glm-template", "anthropic"]);

export function providerReasoning(provider = {}) {
  let mode = provider.reasoningMode ?? "auto";
  if (mode === "auto") {
    // GLM 5.3 accepts low/high/max, not the stock picker's medium/xhigh.
    const glm = /(?:^|\/)glm-5\.3(?:-|$)/i.test(provider.model ?? "");
    let host;
    try { host = new URL(provider.baseUrl).hostname; } catch {}
    mode = provider.apiType === "chat" && glm && host === "api.arnict.com" ? "glm-template"
      : provider.apiType === "chat" && glm && host === "api.z.ai" ? "glm" : "none";
  }
  if (mode === "none") return { mode, efforts: ["none"], defaultEffort: "none" };
  if (mode === "glm" || mode === "glm-template") return { mode, efforts: ["low", "high", "max"], defaultEffort: "max" };
  return { mode, efforts: mode === "effort-extended" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"], defaultEffort: "medium" };
}

export function providerEffort(provider, effort) {
  const profile = providerReasoning(provider);
  return profile.efforts.includes(effort) ? effort : profile.defaultEffort;
}

export function applyProviderReasoning(request, body, provider) {
  const { mode } = providerReasoning(provider);
  if (mode === "none") {
    // Do not send synthetic Codex defaults to providers without reasoning controls.
    delete request.reasoning;
    return;
  }
  const effort = providerEffort(provider, body.reasoning?.effort);
  if (provider.apiType === "responses") request.reasoning = { effort };
  else if (provider.apiType === "anthropic") request.output_config = { effort };
  else {
    request.reasoning_effort = effort;
    if (mode === "glm-template") request.chat_template_kwargs = { reasoning_effort: effort, clear_thinking: true };
    if (mode === "glm") request.thinking = { type: "enabled" };
  }
}
