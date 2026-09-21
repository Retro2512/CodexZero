import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { saveProviders } from "../src/provider-store.mjs";
import { updateProviderKeys, providerKeyStorageSupported } from "../src/provider-secrets.mjs";
import { providerModel, customThreadParams, customTurnParams, findProvider } from "../src/provider-router.mjs";

test("custom picker entries and routing do not replace subscription defaults", () => {
  const provider = { id: "claude", name: "My Claude", model: "configured-model", enabled: true };
  const model = providerModel(provider);
  assert.equal(model.isDefault, false);
  assert.equal(model.model, "custom/claude");
  assert.equal(findProvider([provider], "gpt-5.5"), null);
  assert.throws(() => findProvider([provider], "custom/missing"));
  const input = { model: "custom/claude", approvalPolicy: "on-request", config: { personality: "pragmatic" } };
  const routed = customThreadParams(input, provider, "http://127.0.0.1:1234/v1", "local-token");
  assert.equal(routed.approvalPolicy, input.approvalPolicy);
  assert.equal(routed.config.personality, "pragmatic");
  assert.equal(routed.config["model_providers.codexzero_custom"].requires_openai_auth, false);
  assert.equal(input.modelProvider, undefined);
  assert.equal(customTurnParams({ model: model.model }).serviceTier, null);
});

test("real Codex core can select a custom model and complete a tool round trip", {
  skip: !process.env.CODEX_ZERO_TEST_CORE, timeout: 90000
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-provider-test-"));
  const home = path.join(root, "codex");
  const providerHome = path.join(root, "providers");
  await fs.mkdir(home);
  const requests = [];
  let toolName;
  const mock = http.createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ url: req.url, body: payload, auth: req.headers.authorization });
    if (req.url === "/v1/responses") {
      const item = { type: "message", id: "msg_stock", role: "assistant", status: "completed", content: [{ type: "output_text", text: "STOCK_ROUTE_OK", annotations: [] }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp_stock", status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_stock", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end(); return;
    }
    assert.equal(payload.model, "mock-coder");
    const toolResult = payload.messages.some(m => m.role === "tool");
    const commandTool = payload.tools?.find(tool => ["exec_command", "shell_command"].includes(tool.function?.name));
    toolName = commandTool?.function?.name;
    let message;
    if (!toolResult && commandTool) {
      message = { role: "assistant", content: null, tool_calls: [{ id: "call_smoke", type: "function",
        function: { name: toolName, arguments: JSON.stringify(toolName === "shell_command" ? { command: "echo provider-smoke" } : { cmd: "echo provider-smoke", max_output_tokens: 100 }) } }] };
    } else message = { role: "assistant", content: "CUSTOM_PROVIDER_OK" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chat_test", choices: [{ message, finish_reason: toolResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  });
  await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
  const config = `openai_base_url = "http://127.0.0.1:${mock.address().port}/v1"\n[analytics]\nenabled = false\n`;
  await fs.writeFile(path.join(home, "config.toml"), config);
  await saveProviders([{ id: "mock", name: "Mock coder", apiType: "chat", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "mock-coder", apiKeyEnv: "CZ_TEST_API_KEY", enabled: true }], providerHome);
  if (providerKeyStorageSupported) await updateProviderKeys({ keys: { mock: "mock-only-key" }, activeIds: ["mock"] }, providerHome);
  const spawnCore = () => spawn(process.env.CODEX_ZERO_TEST_LAUNCHER || process.execPath,
    process.env.CODEX_ZERO_TEST_LAUNCHER ? ["app-server"] : [path.resolve("bin/provider-core.mjs"), "app-server"], {
    env: { ...process.env, CODEX_HOME: home, CODEX_ZERO_HOME: providerHome,
      CODEX_ZERO_PROVIDER_CORE: process.env.CODEX_ZERO_TEST_CORE, CZ_TEST_API_KEY: providerKeyStorageSupported ? "" : "mock-only-key", OPENAI_API_KEY: "offline-stock-key" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true
  });
  let child = spawnCore();
  const pending = new Map(); const notifications = []; let serial = 0; let stderr = "";
  function attach(child) {
    child.stderr.on("data", chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    } else notifications.push(message);
    });
  }
  attach(child);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  t.after(async () => {
    child.stdin.end();
    let timer;
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 10000); })]);
    clearTimeout(timer);
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  await rpc("initialize", { clientInfo: { name: "provider_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const models = await rpc("model/list", {});
  assert.ok(models.data.some(m => m.model === "custom/mock"));
  assert.ok(models.data.some(m => !m.model.startsWith("custom/")));
  assert.equal((await rpc("config/batchWrite", { edits: [
    { keyPath: "model", value: "custom/mock", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "none", mergeStrategy: "upsert" }
  ] })).status, "okOverridden");
  const thread = await rpc("thread/start", { model: "custom/mock", cwd: root, approvalPolicy: "never", sandbox: "read-only" });
  assert.equal(thread.modelProvider, "codexzero_custom");
  await rpc("turn/start", { threadId: thread.thread.id, model: "custom/mock", input: [{ type: "text", text: "Say hello", text_elements: [] }] });
  const deadline = Date.now() + 40000;
  while (!notifications.some(n => n.method === "turn/completed") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const complete = notifications.find(n => n.method === "turn/completed");
  assert.ok(complete, `No completed turn: ${stderr.slice(-3000)} ${JSON.stringify(notifications.slice(-5))}`);
  assert.equal(complete.params.turn.status, "completed", JSON.stringify(complete));
  assert.ok(toolName, "The core must expose a command tool");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.auth === "Bearer mock-only-key"));
  assert.ok(notifications.some(n => JSON.stringify(n).includes("CUSTOM_PROVIDER_OK")));
  notifications.length = 0;
  await rpc("turn/start", { threadId: thread.thread.id, model: "gpt-5.5", input: [{ type: "text", text: "Use the normal route", text_elements: [] }] });
  let waitUntil = Date.now() + 20000;
  while (!notifications.some(n => n.method === "turn/completed") && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notifications.find(n => n.method === "turn/completed")?.params.turn.status, "completed", JSON.stringify(notifications.slice(-4)));
  assert.equal(requests.at(-1).url, "/v1/responses");
  assert.equal(requests.at(-1).body.model, "gpt-5.5");
  assert.notEqual(requests.at(-1).auth, "Bearer mock-only-key");
  const costFile = path.join(providerHome, "context-cache", `${thread.thread.id}.json`);
  let costSnapshot;
  const costDeadline = Date.now() + 7000;
  while (Date.now() < costDeadline) {
    costSnapshot = await fs.readFile(costFile, "utf8").then(JSON.parse).catch(() => null);
    if (costSnapshot?.model === "gpt-5.5" && costSnapshot.cost.usd > 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(costSnapshot?.model, "gpt-5.5", "Cache tracking follows actual provider switches");
  assert.ok(costSnapshot.cost.usd > 0, "Real core rollout usage reaches the API equivalent tracker");
  assert.equal(requests.length, 3, "Disabled keep warm sends no extra model requests");
  notifications.length = 0;
  await rpc("turn/start", { threadId: thread.thread.id, model: "custom/mock", input: [{ type: "text", text: "Return to the custom route", text_elements: [] }] });
  waitUntil = Date.now() + 20000;
  while (!notifications.some(n => n.method === "turn/completed") && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notifications.find(n => n.method === "turn/completed")?.params.turn.status, "completed", JSON.stringify(notifications.slice(-4)));
  assert.equal(requests.at(-1).url, "/v1/chat/completions");
  assert.equal(requests.at(-1).body.model, "mock-coder");
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end(); await exited;
  child = spawnCore(); attach(child); notifications.length = 0;
  await rpc("initialize", { clientInfo: { name: "provider_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const resumed = await rpc("thread/resume", { threadId: thread.thread.id });
  assert.equal(resumed.modelProvider, "codexzero_custom");
  await rpc("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Continue after restart", text_elements: [] }] });
  waitUntil = Date.now() + 20000;
  while (!notifications.some(n => n.method === "turn/completed") && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notifications.find(n => n.method === "turn/completed")?.params.turn.status, "completed", JSON.stringify(notifications.slice(-4)));
  assert.equal(requests.at(-1).auth, "Bearer mock-only-key");
  assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), config);
  assert.equal(await fs.stat(path.join(home, "auth.json")).then(() => true, () => false), false);
});
