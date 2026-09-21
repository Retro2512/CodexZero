import { randomUUID } from "node:crypto";

const BODY_LIMIT = 10 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 120_000;

class RequestError extends Error {
  constructor(message, statusCode = 400, code = "invalid_request") {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
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
    if (size > BODY_LIMIT) throw new RequestError("Request body is too large", 413, "request_too_large");
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
    throw new RequestError(`Unsupported input type: ${String(type || "unknown")}`);
  });
}

function parseTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw new RequestError("Tools must be an array");
  const parsed = [];
  const usedNames = new Set();
  const add = (tool, namespace) => {
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
      });
      return;
    }
    if (tool.type === "namespace") {
      if (namespace) throw new RequestError("Nested tool namespaces are not supported");
      if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
        throw new RequestError("Tool namespaces require a name and tools");
      }
      for (const child of tool.tools) add(child, tool.name);
      return;
    }
    throw new RequestError(`Unsupported tool type: ${String(tool.type || "unknown")}`);
  };
  for (const tool of tools) add(tool, undefined);

  for (const tool of parsed) {
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
  return parsed;
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

function toChatRequest(body, provider, items, tools) {
  const messages = [];
  const instructions = instructionText(body.instructions);
  if (instructions) messages.push({ role: "developer", content: instructions });

  for (const item of items) {
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") {
        messages.push({ role: "developer", content: chatContent(item.content, item.role) });
      } else if (item.role === "assistant") {
        pushChatAssistant(messages, { content: chatContent(item.content, item.role) });
      } else {
        messages.push({ role: "user", content: chatContent(item.content, item.role) });
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const args = item.type === "custom_tool_call" ? JSON.stringify({ input: item.input }) : item.arguments;
      const mapped = declaredTool(tools, item.name, item.namespace);
      pushChatAssistant(messages, { tool_calls: [{ id: item.call_id, type: "function", function: { name: mapped?.providerName || item.name, arguments: args } }] });
    } else {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: textValue(item.output, "Tool output") });
    }
  }

  const request = {
    model: provider.model,
    messages,
    stream: false,
  };
  const maxTokens = provider.maxOutputTokens ?? body.max_output_tokens;
  if (maxTokens !== undefined) request.max_completion_tokens = maxTokens;
  if (tools.length) {
    request.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.providerName,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }));
    request.tool_choice = toChatToolChoice(body.tool_choice, tools);
  } else if (body.tool_choice && body.tool_choice !== "none") {
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
  } else if (body.tool_choice && body.tool_choice !== "none") {
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

function usage(inputTokens = 0, outputTokens = 0) {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
}

function fromChat(response, tools) {
  const message = response?.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new Error("Invalid provider response");
  const outputs = [];
  if (typeof message.content === "string" && message.content) outputs.push({ kind: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    if (call?.type === "function" && typeof call.function?.name === "string") {
      const tool = declaredTool(tools, call.function.name);
      if (tool?.kind === "custom") {
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
    usage: usage(response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0),
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
    usage: usage(response.usage?.input_tokens || 0, response.usage?.output_tokens || 0),
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

function synthesizeSse(res, body, provider, normalized) {
  beginSse(res);
  const responseId = normalized.providerId || id("resp");
  let sequence = 0;
  const completed = [];
  const event = (value) => sendEvent(res, { ...value, sequence_number: sequence++ });
  event({ type: "response.created", response: responseShell(body, provider, responseId) });

  for (let outputIndex = 0; outputIndex < normalized.outputs.length; outputIndex += 1) {
    const output = normalized.outputs[outputIndex];
    if (output.kind === "text") {
      const itemId = id("msg");
      const started = { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] };
      event({ type: "response.output_item.added", output_index: outputIndex, item: started });
      event({
        type: "response.content_part.added", item_id: itemId, output_index: outputIndex, content_index: 0,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });
      if (output.text) event({
        type: "response.output_text.delta", item_id: itemId, output_index: outputIndex, content_index: 0,
        delta: output.text, logprobs: [],
      });
      const part = { type: "output_text", text: output.text, annotations: [], logprobs: [] };
      event({ type: "response.output_text.done", item_id: itemId, output_index: outputIndex, content_index: 0, text: output.text, logprobs: [] });
      event({ type: "response.content_part.done", item_id: itemId, output_index: outputIndex, content_index: 0, part });
      const done = { ...started, status: "completed", content: [part] };
      completed.push(done);
      event({ type: "response.output_item.done", output_index: outputIndex, item: done });
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
  }

  event({ type: "response.completed", response: responseShell(body, provider, responseId, completed, "completed", normalized.usage) });
  res.end();
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

function providerHeaders(apiType, apiKey) {
  if (apiType === "anthropic") {
    return {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
    };
  }
  return { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

async function providerFetch(fetchImpl, url, apiType, apiKey, body, signal) {
  return fetchImpl(url, {
    method: "POST",
    headers: providerHeaders(apiType, apiKey),
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
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
export async function serveProviderResponse(req, res, { provider, apiKey, fetchImpl = fetch }) {
  let timeout;
  let disconnected = false;
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
    timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    timeout.unref?.();

    if (provider.apiType === "responses") {
      const nativeBody = { ...body, model: provider.model, stream: true };
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
      const upstream = await providerFetch(fetchImpl, endpoint(provider.baseUrl, "responses"), "responses", apiKey, nativeBody, controller.signal);
      if (!upstream.ok) throw new Error("Provider request failed");
      await passNativeResponse(res, upstream);
      return;
    }

    const items = parseInput(body);
    const tools = parseTools(body.tools);
    const upstreamBody = provider.apiType === "chat"
      ? toChatRequest(body, provider, items, tools)
      : toAnthropicRequest(body, provider, items, tools);
    const path = provider.apiType === "chat" ? "chat/completions" : "messages";
    const upstream = await providerFetch(fetchImpl, endpoint(provider.baseUrl, path), provider.apiType, apiKey, upstreamBody, controller.signal);
    if (!upstream.ok) throw new Error("Provider request failed");
    let providerResponse;
    try { providerResponse = await upstream.json(); }
    catch { throw new Error("Provider returned invalid JSON"); }
    const normalized = provider.apiType === "chat"
      ? fromChat(providerResponse, tools)
      : fromAnthropic(providerResponse, tools);
    synthesizeSse(res, body, provider, normalized);
  } catch (error) {
    if (disconnected) return;
    if (error instanceof RequestError) {
      jsonError(res, error.statusCode, error.message, error.code);
    } else if (controller.signal.aborted) {
      jsonError(res, 504, "Provider request timed out", "provider_timeout");
    } else {
      jsonError(res, 502, "Provider request failed", "provider_error");
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    req.off?.("aborted", abort);
  }
}
