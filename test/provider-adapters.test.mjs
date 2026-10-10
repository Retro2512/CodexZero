import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import { PROVIDER_BODY_LIMIT, serveProviderResponse } from "../src/provider-adapters.mjs";

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

test("chat retries reasoning only replies after tools and accounts for every attempt", async () => {
  const bodies = [];
  const attempts = [];
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: [
    { type: "function_call", call_id: "previous", name: "clock", arguments: "{}" },
    { type: "function_call_output", call_id: "previous", output: "12:00" },
  ] }), res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "zai/glm-5.3-flash-uncensored" },
    apiKey: "test-key",
    recordAttempt: async record => attempts.push(record),
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({
        choices: [{ finish_reason: "stop", message: bodies.length < 3
          ? { content: bodies.length === 1 ? null : " \n", reasoning_content: "hidden reasoning" }
          : { content: "It is noon." } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } },
      });
    },
  });
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[1], bodies[2]);
  const completed = sseEvents(res.text()).at(-1);
  assert.equal(completed.type, "response.completed");
  assert.equal(completed.response.output[0].content[0].text, "It is noon.");
  assert.equal(completed.response.usage.input_tokens, 10);
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 5);
  assert.equal(completed.response.usage.output_tokens, 4);
  assert.equal(completed.response.usage.output_tokens_details.reasoning_tokens, 2);
  assert.deepEqual(attempts.map(record => record.includedInCoreUsage), [false, false, true]);
  assert.equal(attempts.reduce((sum, record) => sum + record.usage.input_tokens, 0), 30);
  assert.equal(attempts.reduce((sum, record) => sum + record.usage.output_tokens, 0), 12);
  assert.doesNotMatch(res.text(), /hidden reasoning/);
});

test("chat persistent empty output fails instead of silently completing", async () => {
  let calls = 0;
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "glm" }, apiKey: "",
    fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: null }, finish_reason: "stop" }] }); },
  });
  assert.equal(calls, 3);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.text()).error.code, "provider_empty_response");
  assert.doesNotMatch(res.text(), /response.completed/);
});

test("chat never retries a valid tool call with no text", async () => {
  let calls = 0;
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello", tools: [{ type: "function", name: "clock" }] }), res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "glm" }, apiKey: "",
    fetchImpl: async () => { calls++; return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      content: null, tool_calls: [{ id: "next", type: "function", function: { name: "clock", arguments: "{}" } }],
    } }] }); },
  });
  assert.equal(calls, 1);
  assert.equal(sseEvents(res.text()).at(-1).response.output[0].call_id, "next");
});

for (const [reason, code] of [["length", "provider_output_limit"], ["content_filter", "provider_content_filter"]]) {
  test(`chat ${reason} is not emitted as a complete answer or retried`, async () => {
    let calls = 0;
    const res = new FakeResponse();
    await serveProviderResponse(request({ input: "hello" }), res, {
      provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "glm" }, apiKey: "",
      fetchImpl: async () => { calls++; return Response.json({ choices: [{ finish_reason: reason, message: { content: "partial" } }] }); },
    });
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.text()).error.code, code);
    assert.doesNotMatch(res.text(), /response.completed/);
  });
}

test("disconnect during an empty reply prevents another provider call", async () => {
  let calls = 0;
  const req = request({ input: "hello" });
  const res = new FakeResponse();
  await serveProviderResponse(req, res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "glm" }, apiKey: "",
    fetchImpl: async () => {
      calls++;
      req.emit("aborted");
      return Response.json({ choices: [{ message: { content: null } }] });
    },
  });
  assert.equal(calls, 1);
  assert.equal(res.text(), "");
});

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

test("chat tool images are multimodal and follow all parallel tool results", async () => {
  for (const outputType of ["function_call_output", "custom_tool_call_output"]) {
    for (const trailingMessage of [false, true]) {
      let sent;
      const image = { type: "input_image", image_url: "data:image/png;base64,YQ==", detail: "high" };
      const callType = outputType === "function_call_output" ? "function_call" : "custom_tool_call";
      const call = id => ({ type: callType, call_id: id, name: "view_image", arguments: "{}", input: "{}" });
      const res = new FakeResponse();
      await serveProviderResponse(request({ input: [
        { role: "user", content: "Inspect both results" }, call("one"), call("two"),
        { type: outputType, call_id: "one", output: [image] },
        { type: outputType, call_id: "two", output: [{ type: "input_text", text: "Caption" }, image, image] },
        ...(trailingMessage ? [{ role: "user", content: "Continue" }] : []),
      ] }), res, {
        provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "vision" }, apiKey: "test",
        fetchImpl: async (url, init) => {
          sent = JSON.parse(init.body);
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
        },
      });
      assert.equal(res.statusCode, 200, res.text());
      assert.deepEqual(sent.messages.map(message => message.role), ["user", "assistant", "tool", "tool", "user", ...(trailingMessage ? ["user"] : [])]);
      assert.deepEqual(sent.messages[1].tool_calls.map(call => call.id), ["one", "two"]);
      assert.equal(sent.messages[2].tool_call_id, "one");
      assert.equal(sent.messages[2].content, "Image result follows.");
      assert.equal(sent.messages[3].content, "Caption");
      assert.doesNotMatch(JSON.stringify(sent.messages.slice(0, 4)), /base64/);
      const images = sent.messages[4].content.filter(part => part.type === "image_url");
      assert.equal(images.length, 3);
      assert.deepEqual(images[0], { type: "image_url", image_url: { url: image.image_url, detail: "high" } });
      assert.match(sent.messages[4].content[0].text, /one/);
      assert.match(sent.messages[4].content[2].text, /two/);
    }
  }
});

test("chat accepts image history above 10 MiB under the shared bridge limit", async () => {
  const image = "data:image/png;base64," + "A".repeat(12 * 1024 * 1024);
  const res = new FakeResponse();
  let fetched = false;
  await serveProviderResponse(request({ input: [
    { type: "function_call", call_id: "large_image", name: "view_image", arguments: "{}" },
    { type: "function_call_output", call_id: "large_image", output: [{ type: "input_image", image_url: image }] },
  ] }), res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "vision" }, apiKey: "test",
    fetchImpl: async (url, init) => {
      fetched = true;
      const sent = JSON.parse(init.body);
      assert.equal(sent.messages.at(-1).content[1].image_url.url, image);
      assert.equal(sent.messages[1].content, "Image result follows.");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
  });
  assert.equal(res.statusCode, 200, res.text());
  assert.equal(fetched, true);
});

test("adapter still rejects streamed requests above the shared 32 MiB limit", async () => {
  assert.equal(PROVIDER_BODY_LIMIT, 32 * 1024 * 1024);
  const res = new FakeResponse();
  let fetched = false;
  const req = Readable.from([Buffer.alloc(PROVIDER_BODY_LIMIT, 32), Buffer.from(" ")]);
  await serveProviderResponse(req, res, {
    provider: { apiType: "chat", baseUrl: "https://gateway.test/v1", model: "vision" }, apiKey: "test",
    fetchImpl: async () => { fetched = true; throw new Error("Must not fetch"); },
  });
  assert.equal(res.statusCode, 413);
  assert.equal(JSON.parse(res.text()).error.code, "request_too_large");
  assert.equal(fetched, false);
});

test("AnyRouter Anthropic requests include its required context header", async () => {
  let call;
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: { apiType: "anthropic", baseUrl: "https://anyrouter.top/v1", model: "claude-opus-5-5" },
    apiKey: "router-secret",
    fetchImpl: async (url, init) => {
      call = { url, headers: init.headers };
      return new Response(JSON.stringify({
        id: "msg_anyrouter",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, "https://anyrouter.top/v1/messages");
  assert.equal(call.headers["anthropic-beta"], "context-1m-2025-08-07");
  assert.equal(call.headers["x-api-key"], "router-secret");
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
      ["chat", { prompt_tokens: 4, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens: 0 }],
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

test("provider unavailability preserves status without exposing upstream details", async () => {
  const res = new FakeResponse();
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: { apiType: "anthropic", baseUrl: "https://anyrouter.top/v1", model: "claude-opus-5-5" },
    apiKey: "do-not-echo",
    fetchImpl: async () => new Response("upstream secret details", { status: 503 }),
  });

  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.text()), {
    error: { message: "Provider unavailable", type: "provider_error", code: "provider_unavailable" },
  });
  assert.doesNotMatch(res.text(), /secret|upstream/i);
});

const glmProvider = { id: "glm_test", apiType: "chat", baseUrl: "https://gateway.test/v1",
  model: "zai/glm-5.3-flash-uncensored", maxOutputTokens: 131072 };
const chatChunk = (delta, finish_reason = null) => ({ id: "stream_test", choices: [{ index: 0, delta, finish_reason }] });
const streamFrame = value => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
const streamUsage = { prompt_tokens: 100, completion_tokens: 8,
  prompt_tokens_details: { cached_tokens: 90 }, completion_tokens_details: { reasoning_tokens: 2 } };

test("GLM streams visible text before completion and emits each assembled tool once", async () => {
  const res = new FakeResponse(), attempts = [];
  const source = Readable.from((async function* () {
    yield Buffer.from(streamFrame(chatChunk({ content: "Checking " })));
    // The downstream delta must have arrived before another upstream chunk.
    await new Promise(resolve => setImmediate(resolve));
    assert.match(res.text(), /response.output_text.delta/);
    assert.doesNotMatch(res.text(), /response.completed/);
    yield Buffer.from(streamFrame(chatChunk({ content: "now", tool_calls: [{ index: 0, id: "call_live", type: "function",
      function: { name: "clock", arguments: '{"zone":' } }] })));
    yield Buffer.from(streamFrame(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] }, "tool_calls")));
    yield Buffer.from(streamFrame({ choices: [], usage: streamUsage }) + streamFrame("[DONE]"));
  })());
  await serveProviderResponse(request({ input: "hello", tools: [{ type: "function", name: "clock" }], reasoning: { effort: "high" } }), res, {
    provider: glmProvider, apiKey: "", rtkRuntime: { available: true }, recordAttempt: async record => attempts.push(record),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.match(body.messages[0].content, /Use rtk/);
      assert.equal(body.max_completion_tokens, 131072);
      return new Response(source, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const events = sseEvents(res.text());
  assert.equal(events.at(-1).type, "response.completed");
  const done = events.filter(event => event.type === "response.output_item.done");
  assert.equal(done.length, 2);
  assert.equal(done[0].item.content[0].text, "Checking now");
  assert.equal(done[1].item.arguments, '{"zone":"UTC"}');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].usageKnown, true);
  assert.equal(attempts[0].usage.input_tokens, 100);
  assert.equal(attempts[0].status, "completed");
});

test("GLM output limit retains streamed text and billing but never executes partial tools", async () => {
  const res = new FakeResponse(), attempts = [];
  const frames = [chatChunk({ content: "Partial" }), chatChunk({ tool_calls: [{ index: 0, id: "partial_tool", type: "function",
    function: { name: "clock", arguments: '{"unfinished":' } }] }, "length"), { choices: [], usage: streamUsage }, "[DONE]"];
  await serveProviderResponse(request({ input: "hello", tools: [{ type: "function", name: "clock" }] }), res, {
    provider: glmProvider, apiKey: "", recordAttempt: async record => attempts.push(record),
    fetchImpl: async () => new Response(frames.map(streamFrame).join(""), { headers: { "content-type": "text/event-stream" } }),
  });
  const events = sseEvents(res.text());
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "provider_output_limit");
  assert.equal(events.at(-1).response.usage.input_tokens, 100);
  assert.ok(!events.some(event => event.item?.type === "function_call"));
  assert.equal(attempts[0].status, "output_limit");
  assert.equal(attempts[0].usageKnown, true);
});

test("persistent blank GLM streams record all failed attempts without invented zero usage", async () => {
  const res = new FakeResponse(), attempts = [];
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: glmProvider, apiKey: "", recordAttempt: async record => attempts.push(record),
    fetchImpl: async () => new Response([chatChunk({ reasoning_content: "hidden" }, "stop"), "[DONE]"].map(streamFrame).join(""),
      { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every(record => record.status === "empty" && record.usageKnown === false && record.usage === null));
  assert.doesNotMatch(res.text(), /response.completed|hidden/);
});

test("a truncated stream records received usage and reports failure after its visible delta", async () => {
  const res = new FakeResponse(), attempts = [];
  await serveProviderResponse(request({ input: "hello" }), res, {
    provider: glmProvider, apiKey: "", recordAttempt: async record => attempts.push(record),
    fetchImpl: async () => new Response([chatChunk({ content: "Visible" }), { choices: [], usage: streamUsage }].map(streamFrame).join(""),
      { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(sseEvents(res.text()).at(-1).type, "response.failed");
  assert.equal(attempts[0].status, "invalid_response");
  assert.equal(attempts[0].usageKnown, true);
});

test("client tool search maps to a Chat function and discovered schemas load on the next call", async () => {
  const search = { type: "tool_search", execution: "client", description: "Find deferred tools", parameters: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
  const deferred = { type: "namespace", name: "calendar", tools: [{ type: "function", name: "events", defer_loading: true,
    parameters: { type: "object", properties: { date: { type: "string" } } } }] };
  const first = new FakeResponse();
  await serveProviderResponse(request({ input: "find calendar", tools: [search, deferred] }), first, {
    provider: glmProvider, apiKey: "", fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.tools.map(tool => tool.function.name), ["tool_search"]);
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "search_one", type: "function",
        function: { name: "tool_search", arguments: '{"query":"calendar events"}' } }] } }], usage: streamUsage });
    },
  });
  const searchCall = sseEvents(first.text()).at(-1).response.output[0];
  assert.equal(searchCall.type, "tool_search_call");
  assert.equal(searchCall.execution, "client");
  assert.deepEqual(searchCall.arguments, { query: "calendar events" });
  const second = new FakeResponse();
  await serveProviderResponse(request({ input: [searchCall, { type: "tool_search_output", execution: "client", call_id: "search_one",
    status: "completed", tools: [deferred] }], tools: [search, deferred] }), second, {
    provider: glmProvider, apiKey: "", fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.tools.map(tool => tool.function.name), ["tool_search", "calendar__events"]);
      assert.equal(body.messages[0].tool_calls[0].function.name, "tool_search");
      assert.equal(body.messages[1].role, "tool");
      assert.match(body.messages[1].content, /calendar.events/);
      assert.doesNotMatch(body.messages[1].content, /properties|parameters/);
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "events_one", type: "function",
        function: { name: "calendar__events", arguments: '{"date":"today"}' } }] } }] });
    },
  });
  const loadedCall = sseEvents(second.text()).at(-1).response.output[0];
  assert.equal(loadedCall.name, "events");
  assert.equal(loadedCall.namespace, "calendar");
});
