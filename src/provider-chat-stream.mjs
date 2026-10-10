const LIMIT = 32 * 1024 * 1024;

function envelope(state) {
  return {
    ...(state.id === undefined ? {} : { id: state.id }),
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: state.content || null,
        ...(state.calls.size ? { tool_calls: [...state.calls].sort(([a], [b]) => a - b).map(([, call]) => ({
          id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
        })) } : {}),
      },
      finish_reason: state.finishReason,
    }],
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  };
}

function fail(message) { throw new Error(message); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function characterBytes(value) {
  const code = value.codePointAt(0);
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

// Only an identical whole label is a repeat. Prefix and suffix overlap may be
// legitimate streamed characters, so fragments otherwise concatenate literally.
function mergeLabel(current, fragment) {
  if (!current) return fragment;
  if (!fragment || current === fragment) return current;
  return current + fragment;
}

/** Read one streamed Chat Completions reply without exposing hidden reasoning. */
export async function readChatStream(body, { onText = () => {}, onUsage = () => {} } = {}) {
  if (!body || typeof body[Symbol.asyncIterator] !== "function") fail("Provider stream is unavailable");
  const state = { id: undefined, content: "", calls: new Map(), finishReason: null, usage: undefined, size: 0 };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = "", data = [], frameSize = 0, pendingCR = false, done = false;

  const append = value => {
    state.size += bytes(value);
    if (state.size > LIMIT) fail("Provider stream output is too large");
  };
  const handle = async payload => {
    if (payload === "[DONE]") { done = true; return; }
    let chunk;
    try { chunk = JSON.parse(payload); } catch { fail("Provider stream returned invalid JSON"); }
    if (!object(chunk)) fail("Provider stream returned an invalid payload");
    if (chunk.error !== undefined) fail("Provider stream returned an error");
    if (chunk.id !== undefined) {
      if (typeof chunk.id !== "string") fail("Provider stream returned an invalid ID");
      state.id ??= chunk.id;
    }
    if (!Array.isArray(chunk.choices)) fail("Provider stream returned invalid choices");
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (!object(chunk.usage)) fail("Provider stream returned invalid usage");
      state.usage = chunk.usage;
      await onUsage(chunk.usage);
    }
    for (const choice of chunk.choices) {
      if (!object(choice) || !Number.isSafeInteger(choice.index) || choice.index < 0) fail("Provider stream returned an invalid choice index");
      if (choice.index !== 0) continue;
      if (state.finishReason !== null) fail("Provider stream continued after completion");
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== "string" || !choice.finish_reason) fail("Provider stream returned an invalid finish reason");
        state.finishReason = choice.finish_reason;
      }
      const delta = choice.delta;
      if (delta === undefined || delta === null) continue;
      if (!object(delta)) fail("Provider stream returned an invalid delta");
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") fail("Provider stream returned invalid text");
        append(delta.content);
        state.content += delta.content;
        if (delta.content) await onText(delta.content);
      }
      if (delta.tool_calls === undefined || delta.tool_calls === null) continue;
      if (!Array.isArray(delta.tool_calls)) fail("Provider stream returned invalid tool calls");
      for (const fragment of delta.tool_calls) {
        if (!object(fragment) || !Number.isSafeInteger(fragment.index) || fragment.index < 0) fail("Provider stream returned an invalid tool index");
        if (fragment.type !== undefined && fragment.type !== "function") fail("Provider stream returned an invalid tool type");
        if (fragment.id !== undefined && typeof fragment.id !== "string") fail("Provider stream returned an invalid tool ID");
        if (fragment.function !== undefined && !object(fragment.function)) fail("Provider stream returned an invalid function");
        const fn = fragment.function ?? {};
        if (fn.name !== undefined && typeof fn.name !== "string") fail("Provider stream returned an invalid function name");
        if (fn.arguments !== undefined && typeof fn.arguments !== "string") fail("Provider stream returned invalid function arguments");
        const call = state.calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        const nextId = mergeLabel(call.id, fragment.id ?? "");
        const nextName = mergeLabel(call.name, fn.name ?? "");
        const nextArgs = call.arguments + (fn.arguments ?? "");
        append(nextId.slice(call.id.length) + nextName.slice(call.name.length) + (fn.arguments ?? ""));
        state.calls.set(fragment.index, { id: nextId, name: nextName, arguments: nextArgs });
      }
    }
  };
  const dispatch = async () => {
    if (!data.length) { frameSize = 0; return; }
    const payload = data.join("\n");
    data = []; frameSize = 0;
    await handle(payload);
  };
  const processLine = async () => {
    if (line === "") await dispatch();
    else if (!line.startsWith(":")) {
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      if (field === "data") data.push(separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, ""));
    }
    line = "";
  };
  const processText = async text => {
    for (const char of text) {
      if (pendingCR) { pendingCR = false; if (char === "\n") continue; }
      if (done) fail("Provider stream continued after DONE");
      if (char === "\r") { await processLine(); pendingCR = true; }
      else if (char === "\n") await processLine();
      else {
        line += char;
        frameSize += characterBytes(char);
        if (frameSize > LIMIT) fail("Provider stream frame is too large");
      }
    }
  };

  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) fail("Provider stream returned invalid bytes");
      await processText(decoder.decode(chunk, { stream: true }));
    }
    await processText(decoder.decode());
    if (line || data.length) fail("Provider stream ended mid frame");
    if (!done || state.finishReason === null) fail("Provider stream ended before completion");
    for (const call of state.calls.values()) if (!call.id || !call.name) fail("Provider stream ended with an incomplete tool call");
    return envelope(state);
  } catch (error) {
    if (error && typeof error === "object") error.providerResponse = envelope(state);
    throw error;
  }
}
