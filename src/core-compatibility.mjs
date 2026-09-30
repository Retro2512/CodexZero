import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { saveProviders } from "./provider-store.mjs";
import { updateProviderKeys, providerKeyStorageSupported } from "./provider-secrets.mjs";

const RPC_TIMEOUT_MS = 15_000;
const STDERR_LIMIT_BYTES = 64 * 1024;
const CLIENT_EXIT_GRACE_MS = 5_000;
const CLIENT_EXIT_KILL_WAIT_MS = 2_000;

function ensureNotAborted(signal) {
  if (signal.aborted) throw signal.reason ?? new Error("Core compatibility check was cancelled");
}

export function sanitizedChildEnvironment({ home, providerHome, sqliteHome, core }, environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    // Do not inherit a desktop permission profile, account credentials, or
    // other Codex settings that can change what this isolated probe exercises.
    if (/^(CODEX_|OPENAI_)/i.test(key)) delete env[key];
  }
  return {
    ...env,
    CODEX_HOME: home,
    CODEX_ZERO_HOME: providerHome,
    CODEX_SQLITE_HOME: sqliteHome,
    CODEX_ZERO_SQLITE_HOME: sqliteHome,
    CODEX_ZERO_CORE_UPDATES: "0",
    CODEX_ZERO_PROVIDER_CORE: core,
    OPENAI_API_KEY: "offline-stock-key",
    CZ_TEST_API_KEY: providerKeyStorageSupported ? "" : "mock-only-key",
  };
}

function createCoreClient({ core, launcher, env, clients }) {
  const executable = launcher || process.execPath;
  const args = launcher ? ["app-server"] : [path.resolve(import.meta.dirname, "../bin/provider-core.mjs"), "app-server"];
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  let serial = 0;
  let stderr = Buffer.alloc(0);
  let exitError = null;
  let exitInfo;
  let closePromise;
  const exitPromise = new Promise(resolve => child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    exitError = new Error(`Core app-server exited with code ${code} and signal ${signal}${stderrSuffix()}`);
    rejectPending(exitError);
    resolve(exitInfo);
  }));

  function stderrSuffix(limit = 3_000) {
    const text = stderr.toString("utf8");
    return text ? `; stderr: ${text.slice(-limit)}` : "";
  }

  function rejectPending(error) {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(error);
    }
  }

  function fail(error) {
    if (exitError) return;
    exitError = error;
    rejectPending(new Error(`${error.message}${stderrSuffix()}`, { cause: error }));
  }

  child.stderr.on("data", chunk => {
    stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
    if (stderr.length > STDERR_LIMIT_BYTES) stderr = stderr.subarray(stderr.length - STDERR_LIMIT_BYTES);
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  lines.on("line", line => {
    if (!line) return;
    let message;
    try { message = JSON.parse(line); }
    catch (error) {
      fail(new Error(`Core app-server emitted invalid JSON: ${error.message}`));
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
    } else notifications.push(message);
  });

  const client = {
    child,
    notifications,
    get stderr() { return stderr.toString("utf8"); },
    get exitError() { return exitError; },
    rpc(method, params) {
      return new Promise((resolve, reject) => {
        if (exitError || child.exitCode != null || child.signalCode != null) {
          reject(exitError ?? new Error(`Core app-server is not running${stderrSuffix()}`));
          return;
        }
        const id = ++serial;
        const timer = setTimeout(() => {
          const item = pending.get(id);
          if (!item) return;
          pending.delete(id);
          item.reject(new Error(`Core RPC ${method} exceeded ${RPC_TIMEOUT_MS} ms${stderrSuffix()}`));
        }, RPC_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
        catch (error) {
          const item = pending.get(id);
          if (item) {
            pending.delete(id);
            clearTimeout(item.timer);
            item.reject(error);
          }
        }
      });
    },
    notify(method, params) {
      if (exitError || child.exitCode != null || child.signalCode != null) throw exitError ?? new Error("Core app-server is not running");
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    terminate() {
      if (child.exitCode == null && child.signalCode == null) child.stdin.end();
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (child.exitCode == null && child.signalCode == null) {
          child.stdin.end();
          const graceful = await waitForExit(exitPromise, CLIENT_EXIT_GRACE_MS);
          if (!graceful) await killProcessTree(child);
        }
        if (child.exitCode == null && child.signalCode == null) {
          const stopped = await waitForExit(exitPromise, CLIENT_EXIT_KILL_WAIT_MS);
          if (!stopped) throw new Error(`Core app-server did not stop after termination${stderrSuffix()}`);
        }
        lines.close();
        clients.delete(client);
      })();
      return closePromise;
    },
  };
  clients.add(client);
  return client;
}

function killProcessTree(child) {
  if (child.pid == null) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, timeout: CLIENT_EXIT_KILL_WAIT_MS,
    }, error => {
      if (error && child.exitCode == null && child.signalCode == null) {
        try { child.kill(); } catch {}
      }
      resolve();
    }));
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch {} }
  return Promise.resolve();
}

function waitForExit(exitPromise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    exitPromise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

async function initialize(client) {
  await client.rpc("initialize", { clientInfo: { name: "provider_smoke", version: "1.0" }, capabilities: { experimentalApi: true } });
  client.notify("initialized", {});
}

async function waitForTurn(client, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    ensureNotAborted(signal);
    const complete = client.notifications.find(item => item.method === "turn/completed");
    if (complete) return complete;
    if (client.exitError) throw client.exitError;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`No completed turn: ${client.stderr.slice(-3_000)} ${JSON.stringify(client.notifications.slice(-5))}`);
}

function sqliteApi() {
  return import("node:sqlite").then(module => module.DatabaseSync).catch(error => {
    throw new Error(`SQLite compatibility checking requires node:sqlite: ${error.message}`, { cause: error });
  });
}

export async function findSqliteFiles(root) {
  const candidates = [], files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) candidates.push(filename);
    }
  }
  await visit(root);
  // Check every header, including databases without a conventional extension,
  // but don't serialize thousands of tiny Windows file operations. Keep the
  // worker's file descriptor and I/O concurrency small and bounded.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (next < candidates.length) {
      const filename = candidates[next++];
      const header = await fs.open(filename, "r").then(async handle => {
        try { const bytes = Buffer.alloc(16); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); return bytes.subarray(0, bytesRead); }
        finally { await handle.close(); }
      }).catch(error => {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      });
      if (header.toString("binary") === "SQLite format 3\0") files.push(filename);
    }
  }));
  return files.sort();
}

async function sqliteSchemaSnapshot(root, DatabaseSync) {
  const files = await findSqliteFiles(root);
  const snapshot = {};
  for (const filename of files) {
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql").all();
      const hasMigrations = database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations'").get();
      const migrations = hasMigrations
        ? database.prepare("SELECT version, success, checksum FROM _sqlx_migrations ORDER BY version, success, checksum").all()
        : [];
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const normalizedMigrations = migrations.map(({ version, success, checksum }) => ({
        version,
        success,
        checksum: checksum == null ? null : Buffer.from(checksum).toString("hex"),
      }));
      snapshot[relative] = createHash("sha256").update(JSON.stringify({ schema, migrations: normalizedMigrations })).digest("hex");
    } finally { database.close(); }
  }
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left.localeCompare(right)));
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Mock model server did not stop")), CLIENT_EXIT_KILL_WAIT_MS);
    server.close(error => {
      clearTimeout(timer);
      error ? reject(error) : resolve();
    });
  });
}

export async function verifyCoreCompatibility(core, { baseline, launcher, timeoutMs = 90_000 } = {}) {
  if (typeof core !== "string" || core.length === 0) throw new TypeError("A core executable path is required");
  if (baseline != null && (typeof baseline !== "string" || baseline.length === 0)) throw new TypeError("Baseline must be a core executable path");
  if (launcher != null && (typeof launcher !== "string" || launcher.length === 0)) throw new TypeError("Launcher must be an executable path");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be a positive finite number");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-provider-compat-"));
  const home = path.join(root, "codex");
  const providerHome = path.join(root, "providers");
  const sqliteHome = path.join(root, "sqlite");
  const clients = new Set();
  const servers = new Set();
  const controller = new AbortController();
  let timer;
  let operation;
  let result;
  let operationError;
  const cleanupErrors = [];

  try {
    await Promise.all([fs.mkdir(home), fs.mkdir(providerHome), fs.mkdir(sqliteHome)]);
    const mock = http.createServer();
    servers.add(mock);
    const requests = [];
    let toolName;
    let mockFailure;
    mock.on("request", (req, res) => {
      void (async () => {
        try {
          if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          requests.push({ url: req.url, body: payload, auth: req.headers.authorization });
          if (req.url === "/v1/responses") {
            const item = { type: "message", id: "msg_stock", role: "assistant", status: "completed", content: [{ type: "output_text", text: "STOCK_ROUTE_OK", annotations: [] }] };
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of [
              { type: "response.created", response: { id: "resp_stock", status: "in_progress", output: [] } },
              { type: "response.output_item.done", output_index: 0, item },
              { type: "response.completed", response: { id: "resp_stock", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
            ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            res.end();
            return;
          }
          assert.equal(payload.model, "mock-coder");
          const toolResult = payload.messages.some(message => message.role === "tool");
          const commandTool = payload.tools?.find(tool => ["exec_command", "shell_command"].includes(tool.function?.name));
          toolName = commandTool?.function?.name;
          let message;
          if (!toolResult && commandTool) {
            message = { role: "assistant", content: null, tool_calls: [{ id: "call_smoke", type: "function",
              function: { name: toolName, arguments: JSON.stringify(toolName === "shell_command" ? { command: "echo provider-smoke" } : { cmd: "echo provider-smoke", max_output_tokens: 100 }) } }] };
          } else message = { role: "assistant", content: "CUSTOM_PROVIDER_OK" };
          res.writeHead(200, { "content-type": "application/json" });
          const longProbe = JSON.stringify(payload.messages).includes("LONG_CONTEXT_PROBE");
          res.end(JSON.stringify({ id: "chat_test", choices: [{ message, finish_reason: toolResult ? "stop" : "tool_calls" }], usage: {
            prompt_tokens: longProbe ? 350000 : 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
            completion_tokens_details: { reasoning_tokens: 2 },
          } }));
        } catch (error) {
          mockFailure ??= error;
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
          res.end("offline mock request failed");
        }
      })();
    });
    await new Promise((resolve, reject) => {
      mock.once("error", reject);
      mock.listen(0, "127.0.0.1", resolve);
    });
    // The isolated probe has no plugins or skills. Prevent marketplace clones
    // and bundled skill extraction into each temporary home. Core database
    // migrations and the full provider/tool checks still run normally.
    // A fresh Windows host may have no sandbox backend selected. Enable its
    // restricted-token backend so read-only commands really remain sandboxed,
    // without installing sandbox accounts or requesting elevation.
    const windowsSandbox = process.platform === "win32" ? '\n[windows]\nsandbox = "unelevated"\n' : "";
    const config = `openai_base_url = "http://127.0.0.1:${mock.address().port}/v1"\n[analytics]\nenabled = false\n[skills.bundled]\nenabled = false\n[features]\nplugins = false\n${windowsSandbox}`;
    await fs.writeFile(path.join(home, "config.toml"), config);

    const envFor = executable => sanitizedChildEnvironment({ home, providerHome, sqliteHome, core: executable });
    const startClient = executable => {
      ensureNotAborted(controller.signal);
      return createCoreClient({ core: executable, launcher, env: envFor(executable), clients });
    };
    const waitForTimeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Core compatibility check exceeded ${timeoutMs} ms`);
        controller.abort(error);
        for (const client of clients) client.terminate();
        reject(error);
      }, timeoutMs);
    });

    operation = (async () => {
      let baselineSchemas;
      let baselineThreadId;
      if (baseline) {
        const DatabaseSync = await sqliteApi();
        ensureNotAborted(controller.signal);
        const baselineClient = startClient(baseline);
        await initialize(baselineClient);
        const baselineThread = await baselineClient.rpc("thread/start", {
          model: "gpt-5.5", cwd: root, ephemeral: false, approvalPolicy: "never", sandbox: "read-only",
        });
        baselineThreadId = baselineThread?.thread?.id;
        assert.ok(baselineThreadId, "Baseline core must create a non-ephemeral stock-model thread");
        await baselineClient.rpc("turn/start", { threadId: baselineThreadId, model: "gpt-5.5", input: [{ type: "text", text: "Warm baseline thread history", text_elements: [] }] });
        const baselineTurn = await waitForTurn(baselineClient, 20_000, controller.signal);
        assert.equal(baselineTurn.params.turn.status, "completed", JSON.stringify(baselineTurn));
        assert.equal(requests.at(-1).url, "/v1/responses");
        assert.equal(requests.at(-1).body.model, "gpt-5.5");
        await baselineClient.close();
        requests.length = 0;
        baselineSchemas = await sqliteSchemaSnapshot(root, DatabaseSync);
        assert.ok(Object.keys(baselineSchemas).length > 0, "Baseline core must initialize a SQLite database");
      }

      ensureNotAborted(controller.signal);
      await saveProviders([{ id: "mock", name: "Mock coder", apiType: "chat", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "mock-coder", apiKeyEnv: "CZ_TEST_API_KEY", enabled: true,
        reasoningMode: "glm-template", contextWindow: 1048576, pricing: { input: .125, read: .05, output: .5, label: "API estimate" } }], providerHome);
      if (providerKeyStorageSupported) await updateProviderKeys({ keys: { mock: "mock-only-key" }, activeIds: ["mock"] }, providerHome);

      let client = startClient(core);
      await initialize(client);
      const models = await client.rpc("model/list", {});
      assert.ok(models.data.some(model => model.model === "custom/mock"));
      assert.deepEqual(models.data.find(model => model.model === "custom/mock").supportedReasoningEfforts.map(effort => effort.reasoningEffort), ["low", "high", "max"]);
      assert.ok(models.data.some(model => !model.model.startsWith("custom/")));
      if (baselineThreadId) {
        const resumedBaselineThread = await client.rpc("thread/resume", { threadId: baselineThreadId });
        assert.ok(resumedBaselineThread, "Candidate core must resume the baseline-saved thread");
      }
      assert.equal((await client.rpc("config/batchWrite", { edits: [
        { keyPath: "model", value: "custom/mock", mergeStrategy: "upsert" },
        { keyPath: "model_reasoning_effort", value: "none", mergeStrategy: "upsert" },
      ] })).status, "okOverridden");
      const thread = await client.rpc("thread/start", { model: "custom/mock", cwd: root, approvalPolicy: "never", sandbox: "read-only" });
      const candidateThreadId = thread?.thread?.id;
      assert.ok(candidateThreadId, "Candidate core must create a custom-model thread");
      assert.equal(thread.modelProvider, "codexzero_custom");
      await client.rpc("turn/start", { threadId: candidateThreadId, model: "custom/mock", effort: "low", input: [{ type: "text", text: "Say hello", text_elements: [] }] });
      const complete = await waitForTurn(client, 40_000, controller.signal);
      assert.equal(complete.params.turn.status, "completed", JSON.stringify(complete));
      assert.ok(toolName, "The core must expose a command tool");
      assert.equal(requests.length, 2);
      const toolOutput = requests.at(-1).body.messages.filter(message => message.role === "tool")
        .map(message => message.content).join("\n");
      assert.match(toolOutput, /(?:^|\r?\n)provider-smoke(?:\r?\n|$)/, "The sandboxed command must actually run");
      assert.ok(requests.every(request => request.body.reasoning_effort === "low"));
      assert.ok(requests.every(request => request.body.chat_template_kwargs.reasoning_effort === "low"));
      assert.ok(requests.every(request => request.auth === "Bearer mock-only-key"));
      assert.ok(client.notifications.some(notification => JSON.stringify(notification).includes("CUSTOM_PROVIDER_OK")));
      assert.ok(client.notifications.some(notification => notification.method === "thread/tokenUsage/updated" && notification.params.tokenUsage.modelContextWindow === 996147),
        "Custom models use the configured context window with a 5% reserve");
      const lastUsage = client.notifications.filter(notification => notification.method === "thread/tokenUsage/updated").at(-1).params.tokenUsage.last;
      assert.equal(lastUsage.cachedInputTokens, 4);
      assert.equal(lastUsage.cacheWriteInputTokens, 2);
      assert.equal(lastUsage.reasoningOutputTokens, 2);
      const customCostFile = path.join(providerHome, "context-cache", `${candidateThreadId}.json`);
      let customCost;
      const customDeadline = Date.now() + 7_000;
      while (Date.now() < customDeadline) {
        ensureNotAborted(controller.signal);
        customCost = await fs.readFile(customCostFile, "utf8").then(JSON.parse).catch(() => null);
        if (customCost?.pricedRequests === 2) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(customCost?.cost.label, "API estimate");
      assert.ok(Math.abs(customCost.cost.usd - .0000059) < 1e-12, "Reported cache tokens reach configured cost accounting");

      client.notifications.length = 0;
      await client.rpc("turn/start", { threadId: candidateThreadId, model: "gpt-5.5", input: [{ type: "text", text: "Use the normal route", text_elements: [] }] });
      let completeTurn = await waitForTurn(client, 20_000, controller.signal);
      assert.equal(completeTurn.params.turn.status, "completed", JSON.stringify(completeTurn));
      assert.equal(requests.at(-1).url, "/v1/responses");
      assert.equal(requests.at(-1).body.model, "gpt-5.5");
      assert.notEqual(requests.at(-1).auth, "Bearer mock-only-key");
      const costFile = path.join(providerHome, "context-cache", `${candidateThreadId}.json`);
      let costSnapshot;
      const costDeadline = Date.now() + 7_000;
      while (Date.now() < costDeadline) {
        ensureNotAborted(controller.signal);
        costSnapshot = await fs.readFile(costFile, "utf8").then(JSON.parse).catch(() => null);
        if (costSnapshot?.model === "gpt-5.5" && costSnapshot.cost.usd > 0) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(costSnapshot?.model, "gpt-5.5", "Cache tracking follows actual provider switches");
      assert.ok(costSnapshot.cost.usd > 0, "Real core rollout usage reaches the API equivalent tracker");
      assert.equal(requests.length, 3, "Disabled keep warm sends no extra model requests");

      client.notifications.length = 0;
      await client.rpc("turn/start", { threadId: candidateThreadId, model: "custom/mock", effort: "high", input: [{ type: "text", text: "Return to the custom route", text_elements: [] }] });
      completeTurn = await waitForTurn(client, 20_000, controller.signal);
      assert.equal(completeTurn.params.turn.status, "completed", JSON.stringify(completeTurn));
      assert.equal(requests.at(-1).url, "/v1/chat/completions");
      assert.equal(requests.at(-1).body.model, "mock-coder");
      assert.equal(requests.at(-1).body.reasoning_effort, "high");

      await client.close();
      client = startClient(core);
      client.notifications.length = 0;
      await initialize(client);
      const resumed = await client.rpc("thread/resume", { threadId: candidateThreadId });
      assert.equal(resumed.modelProvider, "codexzero_custom");
      await client.rpc("turn/start", { threadId: candidateThreadId, input: [{ type: "text", text: "Continue after restart", text_elements: [] }] });
      completeTurn = await waitForTurn(client, 20_000, controller.signal);
      assert.equal(completeTurn.params.turn.status, "completed", JSON.stringify(completeTurn));
      assert.equal(requests.at(-1).auth, "Bearer mock-only-key");

      client.notifications.length = 0;
      const beforeCompaction = requests.length;
      await client.rpc("thread/compact/start", { threadId: candidateThreadId });
      completeTurn = await waitForTurn(client, 20_000, controller.signal);
      assert.equal(completeTurn.params.turn.status, "completed", JSON.stringify(completeTurn));
      assert.equal(requests.length, beforeCompaction + 1);
      assert.equal(requests.at(-1).url, "/v1/chat/completions");
      assert.equal(requests.at(-1).body.model, "mock-coder", "Compaction uses the selected custom model, not a subscription model");
      assert.equal(requests.at(-1).auth, "Bearer mock-only-key");
      assert.equal(await fs.readFile(path.join(home, "config.toml"), "utf8"), config);
      assert.equal(await fs.stat(path.join(home, "auth.json")).then(() => true, () => false), false);

      client.notifications.length = 0;
      const longThread = await client.rpc("thread/start", { model: "custom/mock", cwd: root, approvalPolicy: "never", sandbox: "read-only" });
      const longThreadId = longThread?.thread?.id;
      assert.ok(longThreadId, "Candidate core must create the large-context thread");
      let beforeLong = requests.length;
      // Dense Unicode stays within the independent per-message character limit.
      const largePrompt = "LONG_CONTEXT_PROBE " + "測試".repeat(175000);
      await client.rpc("turn/start", { threadId: longThreadId, model: "custom/mock", input: [{ type: "text", text: largePrompt, text_elements: [] }] });
      completeTurn = await waitForTurn(client, 20_000, controller.signal);
      assert.equal(completeTurn.params.turn.status, "completed", JSON.stringify(completeTurn));
      assert.equal(requests.length - beforeLong, 2, "350k context must not insert compaction into a tool round trip");
      const providerText = requests.at(-1).body.messages.map(message => typeof message.content === "string" ? message.content :
        (message.content ?? []).map(part => part.text ?? "").join("\n")).join("\n");
      assert.ok(providerText.includes(largePrompt), "The full large prompt reaches the provider without truncation or Unicode corruption");
      const largeUsage = client.notifications.filter(notification => notification.method === "thread/tokenUsage/updated").at(-1).params.tokenUsage;
      assert.equal(largeUsage.last.inputTokens, 350000);
      assert.equal(largeUsage.modelContextWindow, 996147);

      client.notifications.length = 0;
      beforeLong = requests.length;
      await client.rpc("turn/start", { threadId: longThreadId, input: [{ type: "text", text: "Continue beyond the old cap", text_elements: [] }] });
      completeTurn = await waitForTurn(client, 20_000, controller.signal);
      assert.equal(completeTurn.params.turn.status, "completed", JSON.stringify(completeTurn));
      assert.equal(requests.length - beforeLong, 1, "350k context must not trigger preturn compaction");
      for (const [settings, expected] of [
        [{ effort: "low", collaborationMode: { mode: "default", settings: { model: "custom/mock", reasoning_effort: "high", developer_instructions: null } } }, "high"],
        [{ effort: "low" }, "low"],
        [{}, "low"],
      ]) {
        ensureNotAborted(controller.signal);
        client.notifications.length = 0;
        await client.rpc("turn/start", { threadId: longThreadId, ...settings, input: [{ type: "text", text: "Continue with selected effort", text_elements: [] }] });
        completeTurn = await waitForTurn(client, 20_000, controller.signal);
        assert.equal(completeTurn.params.turn.status, "completed");
        assert.equal(requests.at(-1).body.reasoning_effort, expected, "Picker effort changes apply to existing tasks and survive subsequent turns");
      }

      assert.equal(mockFailure, undefined, mockFailure?.stack ?? "Offline mock server completed all requests");
      await client.close();
      const tempEntries = await fs.readdir(path.join(home, ".tmp")).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.equal(tempEntries.some(name => name === "plugins" || name.startsWith("plugins-clone-")), false,
        "Offline verification must not fetch a plugin marketplace");

      if (baseline) {
        const afterCandidate = await sqliteSchemaSnapshot(root, await sqliteApi());
        assert.deepEqual(afterCandidate, baselineSchemas,
          "Candidate changed an existing SQLite schema or migration history, or added a database; automatic rollback is unsafe");
        ensureNotAborted(controller.signal);
        const fallbackClient = startClient(baseline);
        await initialize(fallbackClient);
        const read = await fallbackClient.rpc("thread/read", { threadId: candidateThreadId });
        assert.ok(read, "Baseline core must be able to read the candidate-saved thread before automatic rollback");
        const resumedBaselineThread = await fallbackClient.rpc("thread/resume", { threadId: baselineThreadId });
        assert.ok(resumedBaselineThread, "Baseline core must resume the original baseline-saved thread after candidate use");
        await fallbackClient.close();
        const afterBaselineRead = await sqliteSchemaSnapshot(root, await sqliteApi());
        assert.deepEqual(afterBaselineRead, baselineSchemas, "Baseline read changed the SQLite schema or migration history");
      }
    })();
    result = await Promise.race([operation, waitForTimeout]);
  } catch (error) {
    operationError = error;
  } finally {
    clearTimeout(timer);
    const cancellation = new Error("Core compatibility check cleanup");
    controller.abort(cancellation);
    for (const client of clients) client.terminate();
    for (const client of [...clients]) {
      try { await client.close(); } catch (error) { cleanupErrors.push(error); }
    }
    for (const server of servers) {
      try { await closeServer(server); } catch (error) { cleanupErrors.push(error); }
    }
    try { await fs.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); }
    catch (error) { cleanupErrors.push(error); }
  }

  if (operationError && cleanupErrors.length) throw new AggregateError([operationError, ...cleanupErrors], "Core compatibility verification and cleanup failed");
  if (operationError) throw operationError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Core compatibility cleanup failed");
  return result;
}
