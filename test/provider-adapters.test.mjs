import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { serveProviderResponse } from "../src/provider-adapters.mjs";

function request(body, headers = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = "POST";
  req.headers = headers;
  return req;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(chunk) {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.headersSent = true;
    this.writableEnded = true;
  }

  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function sseEvents(text) {
  return text.trim().split("\n\n").map((block) => {
    const lines = block.split("\n");
    return JSON.parse(lines.find((line) => line.startsWith("data: ")).slice(6));
  });
}

async function normalizedUsage(apiType, providerResponse) {
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: { apiType, baseUrl: "https://gateway.test/v1", model: "test-model" },
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify(providerResponse), { status: 200 }),
  });
  assert.equal(res.statusCode, 200, res.text());
  return sseEvents(res.text()).at(-1).response.usage;
}

test("chat adapter maps request text images tools and emits Responses SSE", async () => {
  let call;
  const fetchImpl = async (url, init) => {
    call = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: "chatcmpl_test",
      choices: [{
        message: {
          role: "assistant",
          content: "Checking",
          tool_calls: [{ id: "call_new", type: "function", function: { name: "weather", arguments: "{\"city\":\"Rome\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 8, completion_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const req = request({
    instructions: "Be concise",
    input: [
      { role: "user", content: [
        { type: "input_text", text: "Describe this" },
        { type: "input_image", image_url: "https://example.test/cat.png", detail: "low" },
      ] },
      { type: "function_call", call_id: "call_old", name: "clock", arguments: "{\"zone\":\"UTC\"}" },
      { type: "function_call_output", call_id: "call_old", output: "12:00" },
    ],
    tools: [{ type: "function", name: "weather", description: "Weather", parameters: { type: "object" } }],
    max_output_tokens: 100,
  }, { authorization: "Bearer codex-secret", "x-extra": "private" });
  const res = new FakeResponse();

  await serveProviderResponse(req, res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1/", model: "chat-model", maxOutputTokens: 70 },
    apiKey: "provider-secret",
    fetchImpl,
  });

  assert.equal(call.url, "https://gateway.test/v1/chat/completions");
  assert.deepEqual(call.init.headers, {
    "content-type": "application/json",
    authorization: "Bearer provider-secret",
  });
  assert.equal(call.init.redirect, "error");
  assert.equal(call.body.model, "chat-model");
  assert.equal(call.body.stream, false);
  assert.equal(call.body.max_completion_tokens, 70);
  assert.equal(call.body.messages[0].role, "developer");
  assert.equal(call.body.messages[1].content[1].image_url.url, "https://example.test/cat.png");
  assert.equal(call.body.messages[2].tool_calls[0].id, "call_old");
  assert.deepEqual(call.body.messages[3], { role: "tool", tool_call_id: "call_old", content: "12:00" });
  assert.equal(call.body.tools[0].function.name, "weather");

  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/event-stream/);
  const events = sseEvents(res.text());
  assert.equal(events[0].type, "response.created");
  assert.ok(events.some((event) => event.type === "response.content_part.added"));
  assert.equal(events.find((event) => event.type === "response.output_text.delta").delta, "Checking");
  assert.equal(events.find((event) => event.type === "response.function_call_arguments.done").arguments, "{\"city\":\"Rome\"}");
  const complete = events.at(-1);
  assert.equal(complete.type, "response.completed");
  assert.equal(complete.response.output[1].call_id, "call_new");
  assert.equal(complete.response.usage.total_tokens, 11);
});

test("Anthropic adapter maps system content tool history and custom calls", async () => {
  let call;
  const fetchImpl = async (url, init) => {
    call = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: "msg_provider",
      content: [
        { type: "text", text: "Running" },
        { type: "tool_use", id: "toolu_1", name: "computer__shell", input: { input: "pwd" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 9, output_tokens: 4 },
    }), { status: 200 });
  };
  const req = request({
    instructions: [{ type: "input_text", text: "Use tools" }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "Look" }, { type: "input_image", image_url: "data:image/png;base64,YQ==" }] },
      { type: "function_call", call_id: "prior", name: "lookup", arguments: "{\"q\":1}" },
      { type: "function_call_output", call_id: "prior", output: { answer: 2 } },
    ],
    tools: [
      { type: "function", name: "lookup", parameters: { type: "object" } },
      {
        type: "namespace", name: "computer", description: "Computer tools", tools: [
          { type: "custom", name: "shell", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
        ],
      },
    ],
    tool_choice: { type: "custom", name: "shell" },
  });
  const res = new FakeResponse();

  await serveProviderResponse(req, res, {
    provider: { apiType: "anthropic", baseUrl: "https://api.anthropic.test/v1", model: "claude-test", maxOutputTokens: 55 },
    apiKey: "anthropic-secret",
    fetchImpl,
  });

  assert.equal(call.url, "https://api.anthropic.test/v1/messages");
  assert.deepEqual(call.init.headers, {
    "content-type": "application/json",
    "x-api-key": "anthropic-secret",
    "anthropic-version": "2023-06-01",
  });
  assert.equal(call.body.max_tokens, 55);
  assert.deepEqual(call.body.system, [{ type: "text", text: "Use tools" }]);
  assert.deepEqual(call.body.messages[0].content[1], {
    type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" },
  });
  assert.deepEqual(call.body.messages[1].content[0], { type: "tool_use", id: "prior", name: "lookup", input: { q: 1 } });
  assert.deepEqual(call.body.messages[2].content[0], { type: "tool_result", tool_use_id: "prior", content: "{\"answer\":2}" });
  assert.deepEqual(call.body.tool_choice, { type: "tool", name: "computer__shell" });
  assert.equal(call.body.tools[1].name, "computer__shell");
  assert.deepEqual(call.body.tools[1].input_schema.required, ["input"]);

  const events = sseEvents(res.text());
  const custom = events.find((event) => event.type === "response.custom_tool_call_input.done");
  assert.equal(custom.input, "pwd");
  assert.equal(events.at(-1).response.output[1].call_id, "toolu_1");
  assert.equal(events.at(-1).response.output[1].name, "shell");
  assert.equal(events.at(-1).response.output[1].namespace, "computer");
});

test("chat usage preserves cache reads cache writes and reasoning without double counting", async () => {
  const normalized = await normalizedUsage("chat", {
    choices: [{ message: { role: "assistant", content: "done" } }],
    usage: {
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 },
      completion_tokens: 25,
      completion_tokens_details: { reasoning_tokens: 7 },
      total_tokens: 999,
    },
  });

  assert.deepEqual(normalized, {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 },
    output_tokens: 25,
    output_tokens_details: { reasoning_tokens: 7 },
    total_tokens: 125,
  });
});

test("chat usage supports DeepInfra top level cached token counts without inventing cache hits", async () => {
  const legacy = await normalizedUsage("chat", {
    choices: [{ message: { role: "assistant", content: "done" } }],
    usage: { prompt_tokens: 80, cached_tokens: 20, completion_tokens: 5 },
  });
  assert.deepEqual(legacy.input_tokens_details, { cached_tokens: 20, cache_write_tokens: 0 });

  const explicitZero = await normalizedUsage("chat", {
    choices: [{ message: { role: "assistant", content: "done" } }],
    usage: {
      prompt_tokens: 80,
      cached_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens: 5,
    },
  });
  assert.deepEqual(explicitZero.input_tokens_details, { cached_tokens: 0, cache_write_tokens: 0 });

  const absent = await normalizedUsage("chat", {
    choices: [{ message: { role: "assistant", content: "done" } }],
  });
  assert.deepEqual(absent, {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  });
});

test("Anthropic usage adds uncached cache read and cache creation input exactly once", async () => {
  const normalized = await normalizedUsage("anthropic", {
    content: [{ type: "text", text: "done" }],
    usage: {
      input_tokens: 11,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 30,
      output_tokens: 7,
    },
  });

  assert.deepEqual(normalized, {
    input_tokens: 91,
    input_tokens_details: { cached_tokens: 50, cache_write_tokens: 30 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 98,
  });
});

test("provider usage rejects invalid token counts", async () => {
  const cases = [
    ["chat", { prompt_tokens: -1, completion_tokens: 0 }],
    ["chat", { prompt_tokens: 4, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens: 0 }],
    ["chat", { prompt_tokens: 4, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } }],
    ["chat", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0 }],
    ["anthropic", { input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 1, output_tokens: 0 }],
  ];

  for (const [apiType, providerUsage] of cases) {
    const res = new FakeResponse();
    await serveProviderResponse(request({ input: "hello" }), res, {
      provider: { apiType, baseUrl: "https://gateway.test/v1", model: "test-model" },
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify(apiType === "chat"
        ? { choices: [{ message: { role: "assistant", content: "done" } }], usage: providerUsage }
        : { content: [{ type: "text", text: "done" }], usage: providerUsage }), { status: 200 }),
    });
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.text()).error.code, "provider_error");
  }
});

test("native Responses pass through uses only provider headers and removes metadata", async () => {
  let call;
  const source = "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
  const fetchImpl = async (url, init) => {
    call = { url, init, body: JSON.parse(init.body) };
    return new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const req = request({
    model: "client-model",
    input: "hello",
    stream: false,
    metadata: { private: "value" },
    client_metadata: { subscription: "private" },
    user: "private-user",
    safety_identifier: "private-safety",
  }, { authorization: "Bearer codex-secret", cookie: "private-cookie" });
  const res = new FakeResponse();

  await serveProviderResponse(req, res, {
    provider: { apiType: "responses", baseUrl: "https://openai.test/v1/responses", model: "provider-model" },
    apiKey: "only-this-secret",
    fetchImpl,
  });

  assert.equal(call.url, "https://openai.test/v1/responses");
  assert.deepEqual(call.init.headers, {
    "content-type": "application/json",
    authorization: "Bearer only-this-secret",
  });
  assert.equal(call.body.model, "provider-model");
  assert.equal(call.body.stream, true);
  assert.equal("metadata" in call.body, false);
  assert.equal("client_metadata" in call.body, false);
  assert.equal("user" in call.body, false);
  assert.equal("safety_identifier" in call.body, false);
  assert.equal(res.text(), source);
});

test("local providers may omit authentication", async () => {
  let headers;
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: { apiType: "chat", baseUrl: "http://127.0.0.1:11434/v1", model: "local" },
    apiKey: "",
    fetchImpl: async (_url, init) => {
      headers = init.headers;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200 });
    },
  });

  assert.deepEqual(headers, { "content-type": "application/json" });
  assert.equal(res.statusCode, 200);
  assert.match(res.text(), /response\.completed/);
});

for (const apiType of ["chat", "anthropic"]) {
  test(`${apiType} accepts automatic tool choice when no tools are available`, async () => {
    for (const tools of [undefined, [], [{ type: "namespace", name: "empty", tools: [] }]]) {
      for (const tool_choice of [undefined, "auto", "none"]) {
        let sent;
        const res = new FakeResponse();
        await serveProviderResponse(request({ input: "hello", tools, tool_choice }), res, {
          provider: { apiType, baseUrl: "https://gateway.test/v1", model: "glm-test" },
          apiKey: "test-key",
          fetchImpl: async (_url, init) => {
            sent = JSON.parse(init.body);
            return new Response(JSON.stringify(apiType === "chat"
              ? { choices: [{ message: { role: "assistant", content: "hello" } }] }
              : { content: [{ type: "text", text: "hello" }] }), { status: 200 });
          },
        });
        assert.equal(res.statusCode, 200, res.text());
        assert.ok(sent);
        assert.equal(Object.hasOwn(sent, "tools"), false);
        assert.equal(Object.hasOwn(sent, "tool_choice"), false);
        assert.equal(sseEvents(res.text()).at(-1).type, "response.completed");
      }
    }
  });

  test(`${apiType} still rejects forced tool use when no tools are available`, async () => {
    for (const tool_choice of ["required", { type: "function", name: "missing" }, { type: "custom", name: "missing" }]) {
      let fetched = false;
      const res = new FakeResponse();
      await serveProviderResponse(request({ input: "hello", tools: [], tool_choice }), res, {
        provider: { apiType, baseUrl: "https://gateway.test/v1", model: "glm-test" },
        apiKey: "test-key",
        fetchImpl: async () => { fetched = true; },
      });
      assert.equal(fetched, false);
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.text()).error.message, "Tool choice requires tools");
    }
  });
}

test("unsupported input and tool types return explicit client errors without fetching", async () => {
  for (const body of [
    { input: [{ type: "computer_call" }] },
    { input: "hello", tools: [{ type: "web_search" }] },
  ]) {
    let fetched = false;
    const res = new FakeResponse();
    await serveProviderResponse(request(body), res, {
      provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "model" },
      apiKey: "secret",
      fetchImpl: async () => { fetched = true; },
    });
    assert.equal(fetched, false);
    assert.equal(res.statusCode, 400);
    const error = JSON.parse(res.text()).error;
    assert.match(error.message, /^Unsupported (input|tool) type:/);
  }
});

test("provider failures are generic and do not echo provider content or keys", async () => {
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "model" },
    apiKey: "do-not-echo",
    fetchImpl: async () => new Response("upstream secret details", { status: 401 }),
  });

  assert.equal(res.statusCode, 502);
  assert.deepEqual(JSON.parse(res.text()), {
    error: { message: "Provider request failed", type: "provider_error", code: "provider_error" },
  });
  assert.doesNotMatch(res.text(), /secret|401/i);
});
