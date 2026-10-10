import { randomUUID } from "node:crypto";
import { applyProviderReasoning, isGlmProvider } from "./provider-reasoning.mjs";
import { readChatStream } from "./provider-chat-stream.mjs";
import { rtkGuidance } from "./provider-rtk.mjs";
import { glmToolDiscovery } from "./provider-tool-discovery.mjs";

// Shared with the HTTP bridge; base64 image history can exceed 10 MiB.
export const PROVIDER_BODY_LIMIT = 32 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 120_000;

class RequestError extends Error {
  constructor(message, statusCode = 400, code = "invalid_request") {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ProviderUnavailableError extends Error {}

class ProviderOutputError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function endpoint(baseUrl, path) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RequestError("Provider URL is invalid", 500, "provider_configuration_error");
  }
  const wanted = path.replace(/^\/+/, "");
  if (!url.pathname.replace(/\/+$/, "").endsWith(`/${wanted}`)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${wanted}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readJson(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
      try {
        return JSON.parse(req.body.toString());
      } catch {
        throw new RequestError("Request body must be valid JSON");
      }
    }
    if (req.body && typeof req.body === "object") return req.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > PROVIDER_BODY_LIMIT) throw new RequestError("Request body is too large", 413, "request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) throw new RequestError("Request body is required");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new RequestError("Request body must be valid JSON");
  }
}

function textValue(value, label = "content") {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    throw new RequestError(`${label} must be serializable`);
  }
}

function inputParts(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (!Array.isArray(content)) throw new RequestError("Message content must be text or an array");
  return content.map((part) => {
    if (!part || typeof part !== "object") throw new RequestError("Message content parts must be objects");
    if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") {
      return { type: part.type, text: part.text };
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      return { type: "input_image", image_url: part.image_url, detail: part.detail };
    }
    throw new RequestError(`Unsupported message content type: ${String(part.type || "unknown")}`);
  });
}

function parseInput(body) {
  const input = body.input;
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }];
  if (!Array.isArray(input)) throw new RequestError("Input must be text or an array");
  return input.map((item) => {
    if (!item || typeof item !== "object") throw new RequestError("Input items must be objects");
    const type = item.type || (item.role ? "message" : undefined);
    if (type === "message") {
      if (!["user", "assistant", "system", "developer"].includes(item.role)) {
        throw new RequestError(`Unsupported message role: ${String(item.role || "unknown")}`);
      }
      inputParts(item.content);
      return { ...item, type: "message" };
    }
    if (type === "function_call") {
      if (typeof item.name !== "string" || typeof item.arguments !== "string") {
        throw new RequestError("Function calls require a name and arguments");
      }
      return { ...item, call_id: item.call_id || item.id || id("call") };
    }
    if (type === "function_call_output") {
      if (typeof item.call_id !== "string") throw new RequestError("Function call output requires a call ID");
      return item;
    }
    if (type === "custom_tool_call") {
      if (typeof item.name !== "string" || typeof item.input !== "string") {
        throw new RequestError("Custom tool calls require a name and input");
      }
      return { ...item, call_id: item.call_id || item.id || id("call") };
    }
    if (type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string") throw new RequestError("Custom tool output requires a call ID");
      return item;
    }
    if (type === "tool_search_call") {
      if (item.execution !== "client" || typeof item.call_id !== "string" || !item.arguments || typeof item.arguments !== "object" || Array.isArray(item.arguments)) {
        throw new RequestError("Tool search calls require client execution, a call ID and arguments");
      }
      return item;
    }
    if (type === "tool_search_output") {
      if (item.execution !== "client" || typeof item.call_id !== "string" || !Array.isArray(item.tools)) {
        throw new RequestError("Tool search outputs require client execution, a call ID and tools");
      }
      return item;
    }
    throw new RequestError(`Unsupported input type: ${String(type || "unknown")}`);
  });
}

function parseTools(tools = [], items = []) {
  if (!Array.isArray(tools)) throw new RequestError("Tools must be an array");
  const parsed = [];
  const usedNames = new Set();
  const add = (tool, namespace, loaded = false) => {
    if (!tool || typeof tool !== "object") throw new RequestError("Tool definitions must be objects");
    if (tool.type === "function") {
      if (typeof tool.name !== "string") throw new RequestError("Function tools require a name");
      parsed.push({
        kind: "function",
        name: tool.name,
        namespace,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: tool.parameters && typeof tool.parameters === "object"
          ? tool.parameters
          : { type: "object", properties: {} },
        strict: tool.strict,
        deferred: !loaded && tool.defer_loading === true,
      });
      return;
    }
    if (tool.type === "custom") {
      if (typeof tool.name !== "string") throw new RequestError("Custom tools require a name");
      if (tool.format && !["text", "grammar"].includes(tool.format.type)) {
        throw new RequestError(`Unsupported custom tool format: ${String(tool.format.type || "unknown")}`);
      }
      parsed.push({
        kind: "custom",
        name: tool.name,
        namespace,
        description: typeof tool.description === "string" ? tool.description : undefined,
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        },
        deferred: !loaded && tool.defer_loading === true,
      });
      return;
    }
    if (tool.type === "namespace") {
      if (namespace) throw new RequestError("Nested tool namespaces are not supported");
      if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
        throw new RequestError("Tool namespaces require a name and tools");
      }
      for (const child of tool.tools) add(child, tool.name, loaded);
      return;
    }
    if (tool.type === "tool_search") {
      if (namespace || tool.execution !== "client") throw new RequestError("Only client executed tool search is supported");
      parsed.push({ kind: "search", name: "tool_search", description: tool.description,
        parameters: tool.parameters ?? { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } });
      return;
    }
    throw new RequestError(`Unsupported tool type: ${String(tool.type || "unknown")}`);
  };
  for (const tool of tools) add(tool, undefined);
  for (const item of items) {
    if (item.type === "tool_search_output") for (const tool of item.tools) add(tool, undefined, true);
  }
  // A discovered schema may also be in the current tools array. Preserve one
  // stable provider name and expose it once it has been loaded by core.
  const unique = [];
  for (const tool of parsed) {
    const previous = unique.find(value => value.name === tool.name && value.namespace === tool.namespace && value.kind === tool.kind);
    if (previous) previous.deferred = Boolean(previous.deferred && tool.deferred);
    else unique.push(tool);
  }

  for (const tool of unique) {
    const base = `${tool.namespace ? `${tool.namespace}__` : ""}${tool.name}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 60) || "tool";
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate)) {
      const ending = `_${suffix++}`;
      candidate = `${base.slice(0, 64 - ending.length)}${ending}`;
    }
    tool.providerName = candidate;
    usedNames.add(candidate);
  }
  return unique;
}

function declaredTool(tools, name, namespace) {
  if (namespace !== undefined) return tools.find((tool) => tool.name === name && tool.namespace === namespace);
  return tools.find((tool) => tool.providerName === name)
    || tools.find((tool) => tool.name === name && !tool.namespace)
    || tools.find((tool) => tool.name === name);
}

function instructionText(instructions) {
  if (instructions === undefined || instructions === null) return "";
  if (typeof instructions === "string") return instructions;
  if (Array.isArray(instructions)) {
    return instructions.map((part) => {
      if (part?.type === "input_text" && typeof part.text === "string") return part.text;
      throw new RequestError(`Unsupported instruction type: ${String(part?.type || "unknown")}`);
    }).join("\n");
  }
  throw new RequestError("Instructions must be text or an array");
}

function chatContent(content, role) {
  const parts = inputParts(content);
  if (parts.every((part) => part.type !== "input_image")) return parts.map((part) => part.text).join("");
  if (role !== "user") throw new RequestError("Images are only supported in user messages");
  return parts.map((part) => part.type === "input_image"
    ? { type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } }
    : { type: "text", text: part.text });
}

function pushChatAssistant(messages, piece) {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    if (piece.content) last.content = `${last.content || ""}${piece.content}`;
    if (piece.tool_calls) last.tool_calls = [...(last.tool_calls || []), ...piece.tool_calls];
    return;
  }
  messages.push({ role: "assistant", content: piece.content ?? null, ...(piece.tool_calls ? { tool_calls: piece.tool_calls } : {}) });
}

function toChatRequest(body, provider, items, tools, rtkRuntime) {
  const messages = [];
  const toolImages = [];
  const flushToolImages = () => {
    if (toolImages.length) messages.push({ role: "user", content: toolImages.splice(0) });
  };
  const instructions = instructionText(body.instructions);
  if (instructions) messages.push({ role: "developer", content: instructions });
  const guidance = isGlmProvider(provider) ? rtkGuidance(rtkRuntime) : "";
  if (guidance) messages.push({ role: "developer", content: guidance });

  for (const item of items) {
    // Chat tool messages only accept text. Defer image parts until all tool
    // results are delivered, so parallel calls retain their required ordering.
    if (!["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(item.type)) flushToolImages();
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") {
        messages.push({ role: "developer", content: chatContent(item.content, item.role) });
      } else if (item.role === "assistant") {
        pushChatAssistant(messages, { content: chatContent(item.content, item.role) });
      } else {
        messages.push({ role: "user", content: chatContent(item.content, item.role) });
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "tool_search_call") {
      const args = item.type === "custom_tool_call" ? JSON.stringify({ input: item.input })
        : item.type === "tool_search_call" ? JSON.stringify(item.arguments) : item.arguments;
      const mapped = declaredTool(tools, item.type === "tool_search_call" ? "tool_search" : item.name, item.namespace);
      pushChatAssistant(messages, { tool_calls: [{ id: item.call_id, type: "function", function: { name: mapped?.providerName || item.name, arguments: args } }] });
    } else if (item.type === "tool_search_output") {
      const loaded = parseTools(item.tools).map(tool => `${tool.namespace ? `${tool.namespace}.` : ""}${tool.name}`);
      messages.push({ role: "tool", tool_call_id: item.call_id,
        content: loaded.length ? `Loaded tools: ${loaded.join(", ")}. Their schemas are available in the tool definitions.` : "No matching tools." });
    } else {
      if (Array.isArray(item.output) && item.output.some(part => part?.type === "input_image")) {
        const parts = inputParts(item.output);
        const text = parts.filter(part => part.type !== "input_image").map(part => part.text).join("\n");
        messages.push({ role: "tool", tool_call_id: item.call_id, content: text || "Image result follows." });
        toolImages.push({ type: "text", text: `Images from tool result ${item.call_id}:` },
          ...chatContent(parts.filter(part => part.type === "input_image"), "user"));
      } else {
        messages.push({ role: "tool", tool_call_id: item.call_id, content: textValue(item.output, "Tool output") });
      }
    }
  }
  flushToolImages();

  const request = {
    model: provider.model,
    messages,
    stream: isGlmProvider(provider),
  };
  if (request.stream) request.stream_options = { include_usage: true };
  const maxTokens = provider.maxOutputTokens ?? body.max_output_tokens;
  if (maxTokens !== undefined) request.max_completion_tokens = maxTokens;
  const availableTools = tools.filter(tool => !tool.deferred);
  if (availableTools.length) {
    request.tools = availableTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.providerName,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
    request.tool_choice = toChatToolChoice(body.tool_choice, availableTools);
  } else if (body.tool_choice && !["auto", "none"].includes(body.tool_choice)) {
    throw new RequestError("Tool choice requires tools");
  }
  return request;
}

function toChatToolChoice(choice, tools) {
  if (choice === undefined) return "auto";
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (choice?.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: declaredTool(tools, choice.name, choice.namespace)?.providerName || choice.name } };
  }
  if (choice?.type === "custom" && typeof choice.name === "string") {
    return { type: "function", function: { name: declaredTool(tools, choice.name, choice.namespace)?.providerName || choice.name } };
  }
  throw new RequestError("Unsupported tool choice");
}

function anthropicImage(part) {
  const data = /^data:([^;,]+);base64,(.+)$/s.exec(part.image_url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(part.image_url)) return { type: "image", source: { type: "url", url: part.image_url } };
  throw new RequestError("Anthropic images require an HTTP URL or base64 data URL");
}

function anthropicContent(content, role) {
  return inputParts(content).map((part) => {
    if (part.type === "input_image") {
      if (role !== "user") throw new RequestError("Images are only supported in user messages");
      return anthropicImage(part);
    }
    return { type: "text", text: part.text };
  });
}

function mergeAnthropicMessage(messages, role, blocks) {
  const last = messages.at(-1);
  if (last?.role === role) last.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

function toAnthropicRequest(body, provider, items, tools) {
  const messages = [];
  const system = [];
  const instructions = instructionText(body.instructions);
  if (instructions) system.push({ type: "text", text: instructions });

  for (const item of items) {
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") {
        system.push(...anthropicContent(item.content, item.role));
      } else {
        mergeAnthropicMessage(messages, item.role, anthropicContent(item.content, item.role));
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      let input;
      if (item.type === "custom_tool_call") input = { input: item.input };
      else {
        try { input = JSON.parse(item.arguments); }
        catch { throw new RequestError("Function call arguments must be valid JSON for Anthropic"); }
      }
      const mapped = declaredTool(tools, item.name, item.namespace);
      mergeAnthropicMessage(messages, "assistant", [{ type: "tool_use", id: item.call_id, name: mapped?.providerName || item.name, input }]);
    } else {
      mergeAnthropicMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: item.call_id,
        content: textValue(item.output, "Tool output"),
      }]);
    }
  }
  if (!messages.length) throw new RequestError("At least one user or assistant message is required");

  const request = {
    model: provider.model,
    max_tokens: provider.maxOutputTokens ?? body.max_output_tokens ?? 4096,
    messages,
  };
  if (system.length) request.system = system;
  if (tools.length) {
    request.tools = tools.map((tool) => ({
      name: tool.providerName,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }));
    request.tool_choice = toAnthropicToolChoice(body.tool_choice, tools);
  } else if (body.tool_choice && !["auto", "none"].includes(body.tool_choice)) {
    throw new RequestError("Tool choice requires tools");
  }
  return request;
}

function toAnthropicToolChoice(choice, tools) {
  if (choice === undefined || choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (["function", "custom"].includes(choice?.type) && typeof choice.name === "string") {
    return { type: "tool", name: declaredTool(tools, choice.name, choice.namespace)?.providerName || choice.name };
  }
  throw new RequestError("Unsupported tool choice");
}

function tokenCount(value) {
  if (value === undefined || value === null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid provider usage");
  return value;
}

function tokenSum(...values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Invalid provider usage");
  return total;
}

function usage({
  inputTokens = 0,
  cachedTokens = 0,
  cacheWriteTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
} = {}) {
  inputTokens = tokenCount(inputTokens);
  cachedTokens = tokenCount(cachedTokens);
  cacheWriteTokens = tokenCount(cacheWriteTokens);
  outputTokens = tokenCount(outputTokens);
  reasoningTokens = tokenCount(reasoningTokens);
  if (tokenSum(cachedTokens, cacheWriteTokens) > inputTokens || reasoningTokens > outputTokens) {
    throw new Error("Invalid provider usage");
  }
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens, cache_write_tokens: cacheWriteTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: tokenSum(inputTokens, outputTokens),
  };
}

function chatUsage(providerUsage) {
  const inputTokens = tokenCount(providerUsage?.prompt_tokens);
  const cachedTokens = tokenCount(
    providerUsage?.prompt_tokens_details?.cached_tokens ?? providerUsage?.cached_tokens,
  );
  const cacheWriteTokens = tokenCount(providerUsage?.prompt_tokens_details?.cache_write_tokens);
  const outputTokens = tokenCount(providerUsage?.completion_tokens);
  const reasoningTokens = tokenCount(providerUsage?.completion_tokens_details?.reasoning_tokens);
  return usage({ inputTokens, cachedTokens, cacheWriteTokens, outputTokens, reasoningTokens });
}

function anthropicUsage(providerUsage) {
  const uncachedInputTokens = tokenCount(providerUsage?.input_tokens);
  const cachedTokens = tokenCount(providerUsage?.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(providerUsage?.cache_creation_input_tokens);
  const inputTokens = tokenSum(uncachedInputTokens, cachedTokens, cacheWriteTokens);
  return usage({
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens: tokenCount(providerUsage?.output_tokens),
  });
}

function addUsage(left, right) {
  return usage({
    inputTokens: tokenSum(left.input_tokens, right.input_tokens),
    cachedTokens: tokenSum(left.input_tokens_details.cached_tokens, right.input_tokens_details.cached_tokens),
    cacheWriteTokens: tokenSum(left.input_tokens_details.cache_write_tokens, right.input_tokens_details.cache_write_tokens),
    outputTokens: tokenSum(left.output_tokens, right.output_tokens),
    reasoningTokens: tokenSum(left.output_tokens_details.reasoning_tokens, right.output_tokens_details.reasoning_tokens),
  });
}

function knownUsage(value, apiType) {
  const input = apiType === "chat" ? value?.prompt_tokens : value?.input_tokens;
  const output = apiType === "chat" ? value?.completion_tokens : value?.output_tokens;
  return Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0;
}

function requestMetrics(request) {
  if (!Array.isArray(request.messages)) return null;
  const messageBytes = { developer: 0, user: 0, assistant: 0, tool: 0 };
  for (const message of request.messages) {
    if (Object.hasOwn(messageBytes, message.role)) messageBytes[message.role] += Buffer.byteLength(JSON.stringify(message), "utf8");
  }
  return { messageCount: request.messages.length, toolCount: request.tools?.length ?? 0,
    toolSchemaBytes: Buffer.byteLength(JSON.stringify(request.tools ?? []), "utf8"), messageBytes };
}

function fromChat(response, tools) {
  const finishReason = response?.choices?.[0]?.finish_reason;
  if (finishReason === "length" || finishReason === "content_filter") {
    throw new ProviderOutputError(
      finishReason === "length" ? "Provider output limit reached" : "Provider returned a filtered response",
      finishReason === "length" ? "provider_output_limit" : "provider_content_filter",
    );
  }
  if (finishReason != null && !["stop", "tool_calls", "function_call"].includes(finishReason)) {
    throw new ProviderOutputError("Provider returned an unfinished response", "provider_incomplete_response");
  }
  const message = response?.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new Error("Invalid provider response");
  const outputs = [];
  if (typeof message.content === "string" && message.content.trim()) outputs.push({ kind: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    if (call?.type === "function" && typeof call.function?.name === "string") {
      const tool = declaredTool(tools, call.function.name);
      if (tool?.kind === "search" || tool?.kind === "bridge_search") {
        let argumentsValue;
        try { argumentsValue = JSON.parse(call.function.arguments || "{}"); } catch { throw new Error("Invalid provider tool search arguments"); }
        if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) throw new Error("Invalid provider tool search arguments");
        outputs.push({ kind: tool.kind, callId: call.id || id("call"), name: tool.providerName, arguments: argumentsValue });
      } else if (tool?.kind === "custom") {
        let parsed;
        try { parsed = JSON.parse(call.function.arguments || "{}"); } catch { parsed = {}; }
        outputs.push({ kind: "custom", callId: call.id || id("call"), name: tool.name, namespace: tool.namespace, input: textValue(parsed.input ?? "") });
      } else {
        outputs.push({ kind: "function", callId: call.id || id("call"), name: tool?.name || call.function.name, namespace: tool?.namespace, arguments: call.function.arguments || "{}" });
      }
    } else if (call?.type === "custom" && typeof call.custom?.name === "string") {
      outputs.push({ kind: "custom", callId: call.id || id("call"), name: call.custom.name, input: call.custom.input || "" });
    } else {
      throw new Error("Invalid provider tool call");
    }
  }
  return {
    outputs,
    usage: chatUsage(response.usage),
    providerId: response.id,
  };
}

function fromAnthropic(response, tools) {
  if (!Array.isArray(response?.content)) throw new Error("Invalid provider response");
  const outputs = [];
  for (const block of response.content) {
    if (block?.type === "text" && typeof block.text === "string") outputs.push({ kind: "text", text: block.text });
    else if (block?.type === "tool_use" && typeof block.name === "string") {
      const tool = declaredTool(tools, block.name);
      if (tool?.kind === "custom") {
        outputs.push({ kind: "custom", callId: block.id || id("call"), name: tool.name, namespace: tool.namespace, input: textValue(block.input?.input ?? "") });
      } else {
        outputs.push({ kind: "function", callId: block.id || id("call"), name: tool?.name || block.name, namespace: tool?.namespace, arguments: JSON.stringify(block.input ?? {}) });
      }
    } else {
      throw new Error("Unsupported provider output");
    }
  }
  return {
    outputs,
    usage: anthropicUsage(response.usage),
    providerId: response.id,
  };
}

function responseShell(body, provider, responseId, output = [], status = "in_progress", tokenUsage = null) {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: body.instructions ?? null,
    max_output_tokens: provider.maxOutputTokens ?? body.max_output_tokens ?? null,
    model: provider.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: body.reasoning ?? null,
    store: false,
    temperature: body.temperature ?? null,
    text: body.text ?? { format: { type: "text" } },
    tool_choice: body.tool_choice ?? "auto",
    tools: body.tools ?? [],
    top_p: body.top_p ?? null,
    truncation: body.truncation ?? "disabled",
    usage: tokenUsage,
    user: null,
    metadata: {},
  };
}

function beginSse(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function sendEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function responseStream(res, body, provider) {
  let responseId = id("resp"), started = false, textItem = null, text = "";
  let sequence = 0;
  const completed = [];
  const event = (value) => sendEvent(res, { ...value, sequence_number: sequence++ });
  const begin = providerId => {
    if (started) return;
    responseId = providerId || responseId;
    beginSse(res);
    started = true;
    event({ type: "response.created", response: responseShell(body, provider, responseId) });
  };
  const delta = value => {
    begin();
    const outputIndex = completed.length;
    if (!textItem) {
      const itemId = id("msg");
      const started = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
      textItem = started;
      event({ type: "response.output_item.added", output_index: outputIndex, item: started });
      event({
        type: "response.content_part.added", item_id: itemId, output_index: outputIndex, content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });
    }
    text += value;
    if (value) event({ type: "response.output_text.delta", item_id: textItem.id,
      output_index: outputIndex, content_index: 0, delta: value, logprobs: [] });
  };
  const finishText = (status = "completed") => {
    if (!textItem) return;
    const outputIndex = completed.length, itemId = textItem.id;
    const part = { type: "output_text", text, annotations: [], logprobs: [] };
    event({ type: "response.output_text.done", item_id: itemId, output_index: outputIndex, content_index: 0, text, logprobs: [] });
    event({ type: "response.content_part.done", item_id: itemId, output_index: outputIndex, content_index: 0, part });
    const done = { ...textItem, status, content: [part] };
    completed.push(done);
    event({ type: "response.output_item.done", output_index: outputIndex, item: done });
    textItem = null; text = "";
  };
  const outputItem = output => {
    const outputIndex = completed.length;
    if (output.kind === "text") {
      delta(output.text); finishText();
    } else if (output.kind === "search") {
      const item = { id: id("ts"), type: "tool_search_call", status: "completed", execution: "client",
        call_id: output.callId, arguments: output.arguments };
      completed.push(item);
      event({ type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress" } });
      event({ type: "response.output_item.done", output_index: outputIndex, item });
    } else if (output.kind === "function") {
      const itemId = id("fc");
      const started = {
        id: itemId, type: "function_call", status: "in_progress", call_id: output.callId,
        name: output.name, ...(output.namespace ? { namespace: output.namespace } : {}), arguments: "",
      };
      event({ type: "response.output_item.added", output_index: outputIndex, item: started });
      if (output.arguments) event({ type: "response.function_call_arguments.delta", item_id: itemId, output_index: outputIndex, delta: output.arguments });
      event({ type: "response.function_call_arguments.done", item_id: itemId, output_index: outputIndex, name: output.name, arguments: output.arguments });
      const done = { ...started, status: "completed", arguments: output.arguments };
      completed.push(done);
      event({ type: "response.output_item.done", output_index: outputIndex, item: done });
    } else {
      const itemId = id("ctc");
      const started = {
        id: itemId, type: "custom_tool_call", status: "in_progress", call_id: output.callId,
        name: output.name, ...(output.namespace ? { namespace: output.namespace } : {}), input: "",
      };
      event({ type: "response.output_item.added", output_index: outputIndex, item: started });
      if (output.input) event({ type: "response.custom_tool_call_input.delta", item_id: itemId, output_index: outputIndex, delta: output.input });
      event({ type: "response.custom_tool_call_input.done", item_id: itemId, output_index: outputIndex, input: output.input });
      const done = { ...started, status: "completed", input: output.input };
      completed.push(done);
      event({ type: "response.output_item.done", output_index: outputIndex, item: done });
    }
  };
  return {
    delta,
    complete(normalized) {
      begin(normalized.providerId);
      const alreadyStreamed = Boolean(textItem) && normalized.textWasStreamed === true;
      finishText();
      for (const output of normalized.outputs) {
        if (alreadyStreamed && output.kind === "text") continue;
        outputItem(output);
      }
      event({ type: "response.completed", response: responseShell(body, provider, responseId, completed, "completed", normalized.usage) });
      res.end();
    },
    fail(message, code, tokenUsage) {
      if (!started) return false;
      finishText("incomplete");
      const response = responseShell(body, provider, responseId, completed, "failed", tokenUsage);
      response.error = { message, code, type: "provider_error" };
      event({ type: "response.failed", response });
      res.end();
      return true;
    },
  };
}

function jsonError(res, statusCode, message, code) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { message, type: statusCode >= 500 ? "provider_error" : "invalid_request_error", code } }));
}

function providerHeaders(provider, apiKey) {
  if (provider.apiType === "anthropic") {
    const anyRouter = new URL(provider.baseUrl).hostname === "anyrouter.top";
    return {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
      ...(anyRouter ? { "anthropic-beta": "context-1m-2025-08-07" } : {}),
    };
  }
  return { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

async function providerFetch(fetchImpl, url, provider, apiKey, body, signal) {
  return fetchImpl(url, {
    method: "POST",
    headers: providerHeaders(provider, apiKey),
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
}

function requireUpstreamOk(upstream) {
  if (upstream.ok) return;
  if (upstream.status === 503) throw new ProviderUnavailableError();
  throw new Error("Provider request failed");
}

async function passNativeResponse(res, upstream) {
  beginSse(res);
  if (!upstream.body) throw new Error("Provider response has no body");
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

/**
 * Serves an OpenAI Responses request using a native Responses, Chat Completions,
 * or Anthropic Messages provider.
 */
export async function serveProviderResponse(req, res, { provider, apiKey, fetchImpl = fetch,
  rtkRuntime, recordAttempt, threadId, discoveryState }) {
  let timeout;
  let disconnected = false;
  let stream;
  let totalUsage = usage();
  const requestId = randomUUID();
  const controller = new AbortController();
  const abort = () => { disconnected = true; controller.abort(); };
  req.once?.("aborted", abort);
  res.once?.("close", () => {
    if (!res.writableEnded) abort();
  });

  try {
    if (req.method && req.method !== "POST") throw new RequestError("Only POST requests are supported", 405, "method_not_allowed");
    if (!provider || !["responses", "chat", "anthropic"].includes(provider.apiType)) {
      throw new RequestError("Provider API type is invalid", 500, "provider_configuration_error");
    }
    if (typeof provider.baseUrl !== "string" || typeof provider.model !== "string" || typeof apiKey !== "string") {
      throw new RequestError("Provider configuration is incomplete", 500, "provider_configuration_error");
    }
    if (typeof fetchImpl !== "function") throw new RequestError("Provider fetch is unavailable", 500, "provider_configuration_error");

    const body = await readJson(req);
    stream = responseStream(res, body, provider);
    timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    timeout.unref?.();

    if (provider.apiType === "responses") {
      const nativeBody = { ...body, model: provider.model, stream: true };
      applyProviderReasoning(nativeBody, body, provider);
      delete nativeBody.metadata;
      delete nativeBody.client_metadata;
      delete nativeBody.user;
      delete nativeBody.safety_identifier;
      delete nativeBody.prompt_cache_key;
      delete nativeBody.subscription;
      delete nativeBody.subscription_id;
      delete nativeBody.account;
      delete nativeBody.organization;
      delete nativeBody.project;
      if (provider.maxOutputTokens !== undefined) nativeBody.max_output_tokens = provider.maxOutputTokens;
      const upstream = await providerFetch(fetchImpl, endpoint(provider.baseUrl, "responses"), provider, apiKey, nativeBody, controller.signal);
      requireUpstreamOk(upstream);
      await passNativeResponse(res, upstream);
      return;
    }

    const items = parseInput(body);
    const declaredTools = parseTools(body.tools, items);
    const discovery = isGlmProvider(provider) && (body.tool_choice == null || typeof body.tool_choice === "string")
      ? glmToolDiscovery(declaredTools, items, discoveryState) : null;
    let tools = discovery?.tools() ?? declaredTools;
    const upstreamBody = provider.apiType === "chat"
      ? toChatRequest(body, provider, items, tools, rtkRuntime)
      : toAnthropicRequest(body, provider, items, tools);
    applyProviderReasoning(upstreamBody, body, provider);
    const path = provider.apiType === "chat" ? "chat/completions" : "messages";
    // Some chat providers return only hidden reasoning after a tool result.
    // Never convert that into a successful, empty Responses completion. Retry
    // the same request, without replaying tools or changing the conversation.
    let emptyReplies = 0, discoveryRounds = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      if (controller.signal.aborted) throw new Error("Provider request aborted");
      const startedAt = Date.now();
      const metrics = requestMetrics(upstreamBody);
      let providerResponse, attemptUsage = null, status = "error", accounted = false;
      let completedResponse;
      let textWasStreamed = false;
      const captureUsage = response => {
        if (accounted || !response?.usage) return;
        const value = provider.apiType === "chat" ? chatUsage(response.usage) : anthropicUsage(response.usage);
        totalUsage = addUsage(totalUsage, value);
        if (knownUsage(response.usage, provider.apiType)) attemptUsage = value;
        accounted = true;
      };
      try {
        const upstream = await providerFetch(fetchImpl, endpoint(provider.baseUrl, path), provider, apiKey, upstreamBody, controller.signal);
        if (!upstream.ok) status = "http_error";
        requireUpstreamOk(upstream);
        status = "invalid_response";
        if (provider.apiType === "chat" && upstream.headers?.get("content-type")?.includes("text/event-stream")) {
          let pendingText = "", emitting = false;
          providerResponse = await readChatStream(upstream.body, { onText: delta => {
            if (controller.signal.aborted) throw new Error("Provider request aborted");
            if (!emitting) {
              pendingText += delta;
              if (!pendingText.trim()) return;
              emitting = true; textWasStreamed = true; stream.delta(pendingText); pendingText = "";
            } else stream.delta(delta);
          } });
        } else {
          try { providerResponse = await upstream.json(); }
          catch { throw new Error("Provider returned invalid JSON"); }
        }
        captureUsage(providerResponse);
        if (controller.signal.aborted) throw new Error("Provider request aborted");
        const normalized = provider.apiType === "chat"
          ? fromChat(providerResponse, tools)
          : fromAnthropic(providerResponse, tools);
        if (normalized.outputs.length || provider.apiType !== "chat") {
          status = "completed";
          const searches = normalized.outputs.filter(output => output.kind === "bridge_search");
          if (searches.length) {
            const results = searches.map(output => ({ output, result: discovery.search(output.arguments) }));
            tools = discovery.tools();
            const forwarded = normalized.outputs.filter(output => output.kind !== "bridge_search");
            if (forwarded.some(output => output.kind !== "text")) {
              completedResponse = { ...normalized, outputs: forwarded, textWasStreamed };
            } else {
              if (++discoveryRounds > 4) throw new ProviderOutputError("Provider tool discovery did not settle", "provider_tool_search_limit");
              upstreamBody.messages.push({ role: "assistant", content: providerResponse.choices[0].message.content ?? null,
                tool_calls: searches.map(output => ({ id: output.callId, type: "function",
                  function: { name: output.name, arguments: JSON.stringify(output.arguments) } })) });
              for (const { output, result } of results) upstreamBody.messages.push({ role: "tool", tool_call_id: output.callId, content: JSON.stringify(result) });
              const loadedRequest = toChatRequest(body, provider, items, tools, rtkRuntime);
              upstreamBody.tools = loadedRequest.tools;
              upstreamBody.tool_choice = loadedRequest.tool_choice;
            }
          } else completedResponse = { ...normalized, textWasStreamed };
        } else {
          status = "empty";
        }
      } catch (error) {
        // Usage is billable even if normalization fails or a stream is cut short.
        try { captureUsage(providerResponse ?? error.providerResponse); } catch { attemptUsage = null; }
        if (controller.signal.aborted) status = disconnected ? "cancelled" : "timeout";
        else if (error.code === "provider_output_limit") status = "output_limit";
        else if (error.code === "provider_content_filter") status = "content_filter";
        throw error;
      } finally {
        if (recordAttempt) await recordAttempt({ requestId, attempt: attempt + 1, providerId: provider.id,
          apiType: provider.apiType, threadId, status, latencyMs: Math.max(0, Date.now() - startedAt),
          usageKnown: attemptUsage !== null, usage: attemptUsage, pricing: provider.pricing,
          // Summed attempts would inflate core's current-context measurement.
          // Extra billable calls are included by the ledger cost reader instead.
          includedInCoreUsage: Boolean(completedResponse), requestMetrics: metrics });
      }
      if (completedResponse) { stream.complete(completedResponse); return; }
      if (status === "empty" && ++emptyReplies >= 3) {
        throw new ProviderOutputError("Provider returned no answer or tool call after retrying", "provider_empty_response");
      }
    }
    throw new ProviderOutputError("Provider tool discovery did not settle", "provider_tool_search_limit");
  } catch (error) {
    if (disconnected) return;
    if (res.headersSent && stream?.fail(
      error instanceof ProviderOutputError ? error.message : controller.signal.aborted ? "Provider request timed out" : "Provider request failed",
      error.code ?? (controller.signal.aborted ? "provider_timeout" : "provider_error"), totalUsage)) return;
    if (error instanceof RequestError) {
      jsonError(res, error.statusCode, error.message, error.code);
    } else if (error instanceof ProviderUnavailableError) {
      jsonError(res, 503, "Provider unavailable", "provider_unavailable");
    } else if (controller.signal.aborted) {
      jsonError(res, 504, "Provider request timed out", "provider_timeout");
    } else if (error instanceof ProviderOutputError) {
      jsonError(res, 502, error.message, error.code);
    } else {
      jsonError(res, 502, "Provider request failed", "provider_error");
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    req.off?.("aborted", abort);
  }
}
