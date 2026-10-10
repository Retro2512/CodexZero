import test from "node:test";
import assert from "node:assert/strict";
import { readChatStream } from "../src/provider-chat-stream.mjs";

const encoder = new TextEncoder();
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const done = "data: [DONE]\r\n\r\n";
async function* fragments(text, sizes = [1, 3, 2, 5]) {
  const bytes = encoder.encode(text);
  for (let at = 0, n = 0; at < bytes.length; n++) {
    const end = Math.min(bytes.length, at + sizes[n % sizes.length]);
    yield bytes.subarray(at, end);
    at = end;
  }
}

test("delivers text before the transport finishes", async () => {
  let release, seen;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { seen = resolve; });
  async function* body() {
    yield encoder.encode(event({ id: "reply", choices: [{ index: 0, delta: { content: "Hello" } }] }));
    await gate;
    yield encoder.encode(event({ choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }] }) + done);
  }
  const pending = readChatStream(body(), { onText: async text => seen(text) });
  assert.equal(await observed, "Hello");
  release();
  const result = await pending;
  assert.equal(result.choices[0].message.content, "Hello world");
  assert.equal(result.choices[0].finish_reason, "stop");
});

test("handles UTF8 and CRLF fragmentation, comments, multiline data, tools and usage tail", async () => {
  const chunks = [
    ": ignored\r\n" + event({ id: "reply", choices: [{ index: 1, delta: { content: "ignored" } },
      { index: 0, delta: { content: "hé🌍", tool_calls: [
        { index: 2, id: "call_", type: "function", function: { name: "look_", arguments: "{\"x\":" } },
        { index: 0, id: "first", type: "function", function: { name: "clock", arguments: "{" } },
      ] } }] }),
    event({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 2, id: "2", function: { name: "up", arguments: "1}" } },
      { index: 0, id: "first", function: { name: "clock", arguments: "}" } },
    ] } }] }),
    `data: {"choices":[],\r\ndata: "usage":{"prompt_tokens":9,"completion_tokens":4}}\r\n\r\n`,
    event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + done,
  ].join("");
  const texts = [], usage = [];
  const result = await readChatStream(fragments(chunks), {
    onText: value => texts.push(value), onUsage: value => usage.push(value),
  });
  assert.deepEqual(texts, ["hé🌍"]);
  assert.equal(result.id, "reply");
  assert.deepEqual(result.choices[0].message.tool_calls, [
    { id: "first", type: "function", function: { name: "clock", arguments: "{}" } },
    { id: "call_2", type: "function", function: { name: "look_up", arguments: "{\"x\":1}" } },
  ]);
  assert.deepEqual(result.usage, { prompt_tokens: 9, completion_tokens: 4 });
  assert.deepEqual(usage, [result.usage]);
});

test("ignores reasoning content and returns an empty visible message", async () => {
  const result = await readChatStream(fragments(event({ choices: [{ index: 0,
    delta: { reasoning_content: "private thought" }, finish_reason: "stop" }] }) + done));
  assert.equal(result.choices[0].message.content, null);
  assert.equal(result.choices[0].message.tool_calls, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private thought/);
});

test("concatenates overlapping name and ID fragments literally", async () => {
  const input = event({ choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: "ab", function: { name: "foo", arguments: "{" } },
  ] } }] }) + event({ choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: "abc", function: { name: "o", arguments: "}" } },
  ] }, finish_reason: "tool_calls" }] }) + done;
  const result = await readChatStream(fragments(input));
  assert.deepEqual(result.choices[0].message.tool_calls, [
    { id: "ababc", type: "function", function: { name: "fooo", arguments: "{}" } },
  ]);
});

for (const reason of ["length", "content_filter"]) {
  test(`returns ${reason} for adapter policy`, async () => {
    const result = await readChatStream(fragments(event({ choices: [{ index: 0,
      delta: { content: "partial" }, finish_reason: reason }] }) + done));
    assert.equal(result.choices[0].finish_reason, reason);
  });
}

test("retains usage in a safe partial envelope on provider error", async () => {
  const input = event({ choices: [], usage: { prompt_tokens: 15, completion_tokens: 2 } })
    + `event: error\ndata: {"error":{"message":"sensitive"}}\n\n`;
  await assert.rejects(readChatStream(fragments(input)), error => {
    assert.equal(error.message, "Provider stream returned an error");
    assert.deepEqual(error.providerResponse.usage, { prompt_tokens: 15, completion_tokens: 2 });
    assert.doesNotMatch(JSON.stringify(error.providerResponse), /sensitive/);
    return true;
  });
});

for (const input of [
  "data: nope\n\n",
  event({ choices: [{ index: -1, delta: {} }] }) + done,
  event({ choices: [{ index: 0, delta: { content: 3 } }] }) + done,
  event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "custom" }] } }] }) + done,
  event({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{" } }] } }] }) + done,
  event({ choices: [{ index: 0, delta: {} }] }) + done,
  event({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }] }),
]) {
  test("rejects malformed or truncated streams", async () => {
    await assert.rejects(readChatStream(fragments(input)), error => {
      assert.ok(error.providerResponse);
      return true;
    });
  });
}

test("cancels a web stream when the text callback fails", async () => {
  let canceled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(event({ choices: [{ index: 0, delta: { content: "x" } }] }))); },
    cancel() { canceled = true; },
  });
  await assert.rejects(readChatStream(body, { onText: () => { throw new Error("stop"); } }), /stop/);
  assert.equal(canceled, true);
});

test("preserves partial usage when the iterator throws", async () => {
  async function* body() {
    yield encoder.encode(event({ choices: [], usage: { prompt_tokens: 1 } }));
    throw new Error("connection lost");
  }
  await assert.rejects(readChatStream(body()), error => {
    assert.equal(error.message, "connection lost");
    assert.deepEqual(error.providerResponse.usage, { prompt_tokens: 1 });
    return true;
  });
});
