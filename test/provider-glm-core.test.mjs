import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { sanitizedChildEnvironment } from "../src/core-compatibility.mjs";
import { saveProviders } from "../src/provider-store.mjs";
import { discovery, rtkGuidance } from "../src/provider-rtk.mjs";
import { readCacheSnapshot } from "../src/cache-service.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const compactPrompt = "OFFLINE_COMPACTION_SENTINEL Summarize the fixture task and preserve its result.";
const fixtureMcp = `import {createInterface} from 'node:readline';
const tools = [
 {name:'fixture_echo',description:'fixture_echo unique echo verification',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},
 {name:'fixture_weather',description:'unrelated forecast fixture',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{type:'object',properties:{city:{type:'string'}},required:['city']}}
];
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(m.id==null)return;
 let result;
 if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline-fixture',version:'1'}};
 else if(m.method==='tools/list')result={tools};
 else if(m.method==='tools/call')result={content:[{type:'text',text:'MCP_ACTUAL_RESULT '+m.params.arguments.text}]};
 else if(m.method==='ping')result={};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unknown fixture method'}})+'\\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`;

function client(env) {
  const entry = process.env.CODEX_ZERO_TEST_PROVIDER_ENTRY || path.resolve(import.meta.dirname, "../bin/provider-core.mjs");
  const child = spawn(process.execPath, [entry, "app-server"], {
    env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  let serial = 0, stderr = "", failure;
  const fail = error => {
    failure = error;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.on("error", fail);
  child.stdin.on("error", fail);
  const exited = new Promise(resolve => child.once("exit", (code, signal) => {
    fail(new Error(`Offline core exited (${code}, ${signal}): ${stderr.slice(-2500)}`));
    resolve();
  }));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error("Core emitted invalid JSON")); return; }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id); clearTimeout(waiter.timer);
      message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
    } else events.push({ ...message, observedAt: Date.now() });
  });
  return {
    child, events,
    rpc(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr.slice(-2500)}`)); }, 12000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ method, params })}\n`); },
    async turn(params) {
      const firstEvent = events.length;
      await this.rpc("turn/start", params);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        const complete = events.slice(firstEvent).find(event => event.method === "turn/completed");
        if (complete) {
          assert.equal(complete.params.turn.status, "completed", JSON.stringify(complete.params.turn.error));
          return events.slice(firstEvent);
        }
        await delay(25);
      }
      throw new Error(`Offline turn timed out: ${stderr.slice(-2500)}`);
    },
    async close() {
      child.stdin.end();
      const stopped = await Promise.race([exited.then(() => true), delay(1500).then(() => false)]);
      if (!stopped && child.pid) {
        if (process.platform === "win32") await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, resolve));
        else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
        await Promise.race([exited, delay(1500)]);
      }
      lines.close();
    },
  };
}

test("GLM core discovers MCP tools, streams live, records attempts and compacts at 320k without changing stock routing", {
  skip: !process.env.CODEX_ZERO_TEST_CORE,
  timeout: 85000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-glm-core-"));
  const home = path.join(root, "codex"), providerHome = path.join(home, "codexzero"), sqliteHome = path.join(root, "sqlite");
  let rpcClient;
  const requests = [];
  let mockFailure, finalStreamEndedAt, toolName, performRtkProbe = false;
  const mock = http.createServer((req, res) => void (async () => {
    try {
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: req.url, body });
      if (req.url === "/v1/responses") {
        const item = { type: "message", id: "msg_fixture_stock", role: "assistant", status: "completed", content: [{ type: "output_text", text: "STOCK_ROUTE_OK", annotations: [] }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: "resp_fixture_stock", status: "in_progress", output: [] } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: "resp_fixture_stock", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end(); return;
      }
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(body.model, "zai/glm-5.3-flash-uncensored");
      assert.equal(req.headers.authorization, "Bearer offline-fixture-key");
      assert.equal(body.stream, true);
      assert.equal(body.stream_options.include_usage, true);
      const number = requests.filter(request => request.url === "/v1/chat/completions").length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = value => res.write(`data: ${JSON.stringify({ id: `chat_fixture_${number}`, object: "chat.completion.chunk", ...value })}\n\n`);
      if (number <= 2 || (number === 7 && performRtkProbe)) {
        if (number === 1) {
          assert.match(JSON.stringify(body.messages), /USER_GLOBAL_INSTRUCTIONS_SENTINEL/);
          assert.doesNotMatch(JSON.stringify(body.messages), /# Codex Lean Core v1/);
          assert.ok(body.tools.some(tool => tool.function?.name === "tool_search"), `GLM requests must expose tool discovery; names: ${body.tools.map(tool => tool.function?.name).join(", ")}`);
          assert.equal(body.tools.some(tool => /fixture_echo|fixture_weather/.test(tool.function?.name ?? "")), false, "Deferred MCP schemas must not be sent upfront");
        } else if (number === 2) {
          toolName = body.tools.find(tool => /fixture_echo/.test(tool.function?.name ?? ""))?.function.name;
          assert.ok(toolName, "Search must load the actual MCP schema");
          assert.equal(body.tools.some(tool => /fixture_weather/.test(tool.function?.name ?? "")), false);
          const searchOutput = body.messages.find(message => message.role === "tool" && message.tool_call_id === "call_fixture_search");
          assert.ok(searchOutput, "Search output must round trip through Chat history");
          assert.doesNotMatch(searchOutput.content, /inputSchema|parameters|properties/, "Tool result must not duplicate the loaded schema");
        }
        const name = number === 1 ? "tool_search" : number === 2 ? toolName : "exec_command";
        if (number === 7) assert.ok(body.tools.some(tool => tool.function?.name === name), "RTK probe must use the actual core command tool");
        const args = JSON.stringify(number === 1 ? { query: "fixture_echo", limit: 1 } : number === 2 ? { text: "fixture-input" } : { cmd: "rtk --version", max_output_tokens: 100 });
        const id = number === 1 ? "call_fixture_search" : number === 2 ? "call_fixture_echo" : "call_fixture_rtk";
        send({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args.slice(0, 8) } }] }, finish_reason: null }] });
        await delay(20);
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        if (number === 3) assert.ok(body.messages.some(message => message.role === "tool" && message.content.includes("MCP_ACTUAL_RESULT fixture-input")), `The discovered MCP tool must actually execute; fixture tool outputs: ${JSON.stringify(body.messages.filter(message => message.role === "tool"))}`);
        if (number === 5) assert.ok(body.messages.some(message => message.role === "user" && message.content === compactPrompt), "330k usage must trigger the configured compaction prompt before the next user turn");
        if (number === 8 && performRtkProbe) assert.ok(body.messages.some(message => message.role === "tool" && message.tool_call_id === "call_fixture_rtk" && /rtk\s+\d+\.\d+/i.test(message.content)), "The sandboxed command must actually execute host RTK and return its version");
        send({ choices: [{ index: 0, delta: { role: "assistant", content: number === 5 ? "SAFE_COMPACT_SUMMARY" : "LIVE_FIXTURE_TEXT" }, finish_reason: null }] });
        if (number === 3) await delay(600);
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      const input = number === 4 ? 330000 : 30;
      send({ choices: [], usage: { prompt_tokens: input, completion_tokens: 4, total_tokens: input + 4, prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } } });
      if (number === 3) finalStreamEndedAt = Date.now();
      res.end("data: [DONE]\n\n");
    } catch (error) {
      mockFailure ??= error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  })());
  t.after(async () => {
    await rpcClient?.close();
    mock.closeAllConnections?.();
    if (mock.listening) await new Promise(resolve => mock.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(providerHome, { recursive: true }), fs.mkdir(sqliteHome, { recursive: true })]);
  await new Promise((resolve, reject) => { mock.once("error", reject); mock.listen(0, "127.0.0.1", resolve); });
  const instructionsFile = path.join(root, "instructions.md");
  const sentinel = Buffer.from("USER_GLOBAL_INSTRUCTIONS_SENTINEL\r\nOnly perform the requested fixture task.\r\n");
  await fs.writeFile(instructionsFile, sentinel);
  const mcpFile = path.join(root, "fixture-mcp.mjs");
  await fs.writeFile(mcpFile, fixtureMcp);
  const tomlString = value => JSON.stringify(value.replaceAll("\\", "/"));
  const config = `openai_base_url = "http://127.0.0.1:${mock.address().port}/v1"\nmodel_instructions_file = ${tomlString(instructionsFile)}\ncompact_prompt = ${JSON.stringify(compactPrompt)}\n[analytics]\nenabled = false\n[skills.bundled]\nenabled = false\n[features]\nplugins = false\n[mcp_servers.offline_fixture]\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(mcpFile)}]\nstartup_timeout_sec = 5\n${process.platform === "win32" ? '[windows]\nsandbox = "unelevated"\n' : ""}`;
  await fs.writeFile(path.join(home, "config.toml"), config);
  await saveProviders([{ id: "offline_glm", name: "Offline GLM", apiType: "chat", model: "zai/glm-5.3-flash-uncensored", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKeyEnv: "CZ_TEST_API_KEY", enabled: true, reasoningMode: "glm-template", contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: .1, read: .01, output: .5, label: "Fixture" } }], providerHome);
  const env = { ...sanitizedChildEnvironment({ home, providerHome, sqliteHome, core: process.env.CODEX_ZERO_TEST_CORE }), CZ_TEST_API_KEY: "offline-fixture-key" };
  performRtkProbe = discovery({ environment: env }).available;
  rpcClient = client(env);
  await rpcClient.rpc("initialize", { clientInfo: { name: "glm_offline_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  rpcClient.notify("initialized", {});
  const models = await rpcClient.rpc("model/list", {});
  assert.deepEqual(models.data.find(model => model.model === "custom/offline_glm").supportedReasoningEfforts.map(item => item.reasoningEffort), ["low", "high", "max"]);
  const thread = await rpcClient.rpc("thread/start", { model: "custom/offline_glm", cwd: root, approvalPolicy: "never", sandbox: "read-only" });
  const threadId = thread.thread.id;
  assert.equal(thread.modelProvider, "codexzero_custom");
  const input = text => [{ type: "text", text, text_elements: [] }];
  const events = await rpcClient.turn({ threadId, effort: "low", input: input("Discover and run fixture_echo") }).catch(error => { throw mockFailure ?? error; });
  assert.equal(requests.length, 3);
  assert.ok(events.some(event => event.method === "item/agentMessage/delta" && event.params.delta.includes("LIVE_FIXTURE_TEXT") && event.observedAt < finalStreamEndedAt), "Assistant text must reach core clients before the upstream stream ends");
  const firstUsages = events.filter(event => event.method === "thread/tokenUsage/updated").map(event => event.params.tokenUsage.last);
  assert.ok(firstUsages.some(item => item.inputTokens === 30));
  assert.ok(firstUsages.every(item => item.inputTokens <= 30), "Internal discovery usage must not inflate the core current context measurement");
  const guidance = rtkGuidance(discovery({ environment: env }));
  for (const request of requests) {
    assert.equal(request.body.reasoning_effort, "low");
    assert.equal(request.body.chat_template_kwargs.reasoning_effort, "low");
    const text = JSON.stringify(request.body.messages);
    assert.match(text, /USER_GLOBAL_INSTRUCTIONS_SENTINEL/);
    assert.doesNotMatch(text, /# Codex Lean Core v1/);
    if (guidance) assert.equal(text.split(guidance).length - 1, 1, "RTK guidance must be present once per request");
  }
  await rpcClient.turn({ threadId, effort: "high", input: input("REPORT_LARGE_USAGE") }).catch(error => { throw mockFailure ?? error; });
  assert.equal(requests.length, 4);
  await rpcClient.turn({ threadId, input: input("Continue after large usage") }).catch(error => { throw mockFailure ?? error; });
  assert.equal(requests.length, 6, "Exactly one automatic compaction call must precede the continued turn");
  assert.ok(requests.slice(3).every(request => request.body.reasoning_effort === "high" && request.body.chat_template_kwargs.reasoning_effort === "high"));
  const ledgerFile = path.join(providerHome, "provider-usage.jsonl");
  let ledger = [];
  for (let attempts = 0; attempts < 100; attempts++) {
    ledger = (await fs.readFile(ledgerFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
    if (ledger.length === 6) break;
    await delay(25);
  }
  assert.equal(ledger.length, 6);
  assert.equal(new Set(ledger.map(item => `${item.requestId}:${item.attempt}`)).size, 6);
  assert.equal(ledger[0].requestId, ledger[1].requestId, "Internal discovery calls belong to one core request");
  assert.deepEqual(ledger.map(item => item.attempt), [1, 2, 1, 1, 1, 1]);
  assert.deepEqual(ledger.map(item => item.includedInCoreUsage), [false, true, true, true, true, true]);
  assert.ok(ledger.every(item => item.threadId === threadId && /^[0-9a-f-]{36}$/i.test(item.threadId) && item.status === "completed" && item.usageKnown));
  assert.deepEqual(ledger.map(item => item.usage.input_tokens), [30, 30, 30, 330000, 30, 30]);
  assert.ok(ledger.every(item => item.usage.input_tokens_details.cached_tokens === 7 && item.usage.input_tokens_details.cache_write_tokens === 3 && item.usage.output_tokens_details.reasoning_tokens === 2));
  assert.equal(ledger.reduce((sum, item) => sum + item.usage.input_tokens, 0), 330150);
  assert.equal(ledger.reduce((sum, item) => sum + item.usage.output_tokens, 0), 24);
  assert.ok(Math.abs(ledger.reduce((sum, item) => sum + item.estimatedCostUsd, 0) - .03302322) < 1e-12,
    "Every provider attempt, including internal discovery, must be accounted for at the configured fixture rates");
  const costSnapshot = await readCacheSnapshot(threadId, providerHome);
  assert.ok(Math.abs(costSnapshot.cost.usd - .03302322) < 1e-12,
    `Displayed cost must match all ledger attempts without inflating current context: ${JSON.stringify(costSnapshot.cost)}`);
  if (performRtkProbe) {
    await rpcClient.turn({ threadId, input: input("Run the read only RTK version probe") }).catch(error => { throw mockFailure ?? error; });
    assert.equal(requests.length, 8, "RTK command execution requires exactly one tool call and one final reply");
  }
  await rpcClient.turn({ threadId, model: "gpt-5.5", input: input("Use the stock route") });
  assert.equal(requests.length, performRtkProbe ? 9 : 7);
  assert.equal(requests.at(-1).url, "/v1/responses");
  assert.equal(requests.at(-1).body.model, "gpt-5.5");
  assert.equal(requests.at(-1).body.chat_template_kwargs, undefined);
  assert.equal(mockFailure, undefined, mockFailure?.stack);
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), config);
  assert.deepEqual(await fs.readFile(instructionsFile), sentinel);
  assert.equal(await fs.stat(path.join(home, "auth.json")).then(() => true, () => false), false);
});
