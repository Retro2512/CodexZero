import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { codexZeroHome } from "./paths.mjs";
import { readProviders } from "./provider-store.mjs";
import { startProviderBridge } from "./provider-bridge.mjs";
import { PROVIDER_ID, providerModel, findProvider, selectedModel, customThreadParams, customTurnParams } from "./provider-router.mjs";
import { CacheMonitor } from "./cache-monitor.mjs";

/** A transparent JSON RPC shim. Ordinary models never pass through the HTTP bridge. */
export async function runProviderAppServer({ core, args, home, input = process.stdin, output = process.stdout, error = process.stderr, environment = process.env }) {
  const bridge = await startProviderBridge({ home, environment });
  const providerConfig = customThreadParams({}, { id: "unused" }, bridge.baseUrl, bridge.token).config[`model_providers.${PROVIDER_ID}`];
  const toml = `{ ${Object.entries(providerConfig).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }`;
  const appearanceServer = path.resolve(import.meta.dirname, "..", "bin", "sidebar-appearance-mcp.mjs");
  const appearanceConfig = `{ command = ${JSON.stringify(process.execPath)}, args = [${JSON.stringify(appearanceServer)}], env = { CODEX_ZERO_HOME = ${JSON.stringify(home ?? codexZeroHome(environment))} }, startup_timeout_sec = 5, tool_timeout_sec = 120 }`;
  const child = spawn(core, ["-c", `model_providers.${PROVIDER_ID}=${toml}`, "-c", `mcp_servers.codexzero_appearance=${appearanceConfig}`, ...args], {
    env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  child.stderr.pipe(error, { end: false });
  const pending = new Map();
  const threads = new Map();
  const active = new Set();
  const closing = new Map();
  const switching = new Set();
  const queues = new Map();
  const userPending = new Map();
  let sequence = 0;
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const emit = message => output.write(`${JSON.stringify(message)}\n`);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `cz_internal_${++sequence}`;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Codex did not respond")); }, 30000);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params });
  });
  const enqueue = (id, work) => {
    const queued = (queues.get(id) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(id, queued);
    void queued.finally(() => { if (queues.get(id) === queued) queues.delete(id); }).catch(() => {});
    return queued;
  };
  const cache = new CacheMonitor({ home, rpc, enqueue,
    isBusy: id => active.has(id) || switching.has(id) || (userPending.get(id) || 0) > 0 });
  cache.start();
  function remember(result, params = {}) {
    cache.remember(result);
    if (result?.thread?.id && result.modelProvider) {
      const previous = threads.get(result.thread.id);
      threads.set(result.thread.id, { ...previous, ...params, model: result.model,
        normalConfig: result.modelProvider === PROVIDER_ID ? previous?.normalConfig : params.config,
        modelProvider: result.modelProvider, cwd: result.cwd,
        approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox ?? result.sandboxPolicy,
        runtimeWorkspaceRoots: result.runtimeWorkspaceRoots,
        permissions: result.activePermissionProfile?.id ?? params.permissions ?? previous?.permissions });
    }
  }
  const responses = createInterface({ input: child.stdout, crlfDelay: Infinity });
  responses.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    cache.notify(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timeout); pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "Codex request failed"));
      else waiter.resolve(message.result);
      return;
    }
    const threadId = message.params?.threadId ?? message.params?.thread?.id;
    if (message.method === "turn/started") active.add(threadId);
    if (message.method === "turn/completed") active.delete(threadId);
    if (message.method === "thread/closed") {
      closing.get(threadId)?.();
      if (switching.has(threadId)) return;
    }
    if (switching.has(threadId) && message.method === "thread/started") return;
    emit(message);
  });

  async function switchProvider(threadId, model, provider) {
    const previous = threads.get(threadId);
    if (!previous) throw new Error("Reopen this task before changing its provider");
    const desired = provider ? PROVIDER_ID : "openai";
    if (previous.modelProvider === desired) return;
    if (active.has(threadId)) throw new Error("Wait for the current response before changing providers");
    switching.add(threadId);
    let timer;
    try {
      const closed = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The task is still open. Reopen it before changing providers.")), 15000);
        closing.set(threadId, resolve);
      });
      // Attach a rejection handler immediately while unsubscribe is in flight.
      closed.catch(() => {});
      await rpc("thread/unsubscribe", { threadId });
      let params = { threadId, model, modelProvider: desired, cwd: previous.cwd,
        config: previous.normalConfig,
        approvalPolicy: previous.approvalPolicy, runtimeWorkspaceRoots: previous.runtimeWorkspaceRoots,
        ...(previous.permissions ? { permissions: previous.permissions } :
          { sandbox: ({ readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" })[previous.sandboxPolicy?.type] ?? previous.sandbox }),
        baseInstructions: previous.baseInstructions,
        developerInstructions: previous.developerInstructions,
        excludeTurns: true };
      if (provider) params = customThreadParams(params, provider, bridge.baseUrl, bridge.token);
      let resumed;
      try { resumed = await rpc("thread/resume", params); }
      catch (failure) {
        if (!failure.message.includes("is closing")) throw failure;
        await closed;
        resumed = await rpc("thread/resume", params);
      }
      if (resumed.modelProvider !== desired) throw new Error("Codex could not change the provider. Reopen this task.");
      remember(resumed, params);
    } finally {
      clearTimeout(timer); closing.delete(threadId); switching.delete(threadId);
    }
  }

  async function request(message) {
    if (message.id == null || !message.method) { send(message); return; }
    const params = message.params || {};
    try {
      if (["config/value/write", "config/batchWrite"].includes(message.method)) {
        const edits = params.edits ?? [params];
        const customSelection = edits.find(edit =>
          ((edit.keyPath === "model" || edit.keyPath?.endsWith(".model")) && String(edit.value).startsWith("custom/")) ||
          ((edit.keyPath === "model_provider" || edit.keyPath?.endsWith(".model_provider")) && edit.value === PROVIDER_ID));
        if (customSelection) {
          if (edits.some(edit => !/(^|\.)(model|model_provider|model_reasoning_effort)$/.test(edit.keyPath))) {
            throw new Error("Choose a custom model separately from other setting changes");
          }
          if (String(customSelection.value).startsWith("custom/")) findProvider(await readProviders(home), customSelection.value);
          const directory = home ?? codexZeroHome();
          await fs.mkdir(directory, { recursive: true });
          const filePath = path.resolve(directory, "provider-selection.json");
          const version = randomUUID();
          const temporary = `${filePath}.${version}.tmp`;
          await fs.writeFile(temporary, JSON.stringify({ version, edits }), { mode: 0o600 });
          await fs.rename(temporary, filePath);
          // Desktop explicitly supports session model choices when a global
          // config write is overridden. Keep its native picker behavior while
          // storing this choice outside the subscription's config.toml.
          emit({ id: message.id, result: { status: "okOverridden", version, filePath, overriddenMetadata: null } });
          return;
        }
      }
      if (message.method === "model/list") {
        const result = await rpc(message.method, params);
        const providers = (await readProviders(home)).filter(p => p.enabled);
        if (!result.nextCursor) result.data.push(...providers.map(providerModel));
        emit({ id: message.id, result }); return;
      }
      if (message.method === "thread/read") {
        const result = await rpc(message.method, params);
        remember(result, params);
        emit({ id: message.id, result }); return;
      }
      if (["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
        const provider = findProvider(await readProviders(home), params.model);
        let routed = provider ? customThreadParams(params, provider, bridge.baseUrl, bridge.token) : params;
        if (!params.model && params.threadId && ["thread/resume", "thread/fork"].includes(message.method)) {
          const saved = await rpc("thread/read", { threadId: params.threadId, includeTurns: false });
          if (saved.thread?.modelProvider === PROVIDER_ID) {
            const restored = findProvider(await readProviders(home), saved.thread.model);
            if (!restored) throw new Error("Select a custom model to resume this task");
            routed = customThreadParams(params, restored, bridge.baseUrl, bridge.token);
          }
        }
        if (params.ephemeral) routed = { ...routed, config: { ...routed.config, "mcp_servers.codexzero_appearance": { enabled: false, command: "" } } };
        const result = await rpc(message.method, routed);
        remember(result, routed);
        emit({ id: message.id, result }); return;
      }
      if (message.method === "turn/start") {
        await cache.cancel(params.threadId);
        cache.userActivity(params.threadId);
        const state = threads.get(params.threadId);
        const model = selectedModel(params) ?? state?.model;
        cache.select(params.threadId, params, model);
        const provider = findProvider(await readProviders(home), model);
        if (provider || state?.modelProvider === PROVIDER_ID) {
          await switchProvider(params.threadId, model, provider);
          let routed = provider ? customTurnParams(params, provider) : params;
          if (state?.sandboxPolicy && !routed.sandboxPolicy && !routed.permissions) {
            routed = { ...routed, sandboxPolicy: state.sandboxPolicy };
          }
          const result = await rpc(message.method, routed);
          const updated = threads.get(params.threadId);
          if (updated) updated.model = model;
          emit({ id: message.id, result }); return;
        }
        const result = await rpc(message.method, params);
        if (state) state.model = model;
        emit({ id: message.id, result }); return;
      }
      if (message.method === "turn/steer") cache.userActivity(params.threadId);
      if (message.method === "thread/list" && params.modelProviders == null) {
        send({ ...message, params: { ...params, modelProviders: [] } }); return;
      }
      // Unhandled methods, account operations, approvals and server request replies
      // are forwarded byte for byte semantically without changing subscription auth.
      send(message);
    } catch (failure) {
      emit({ id: message.id, error: { code: -32000, message: failure.message } });
    }
  }
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { emit({ id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
    const threadId = message.params?.threadId;
    if (threadId && ["turn/start", "thread/resume"].includes(message.method)) {
      userPending.set(threadId, (userPending.get(threadId) || 0) + 1);
      void enqueue(threadId, async () => {
        try { await request(message); }
        finally { const count = (userPending.get(threadId) || 1) - 1; if (count) userPending.set(threadId, count); else userPending.delete(threadId); }
      });
    } else void request(message);
  });
  lines.on("close", () => { cache.close(); child.stdin.end(); });
  const code = await new Promise((resolve, reject) => { child.once("exit", code => resolve(code ?? 1)); child.once("error", reject); }).finally(async () => {
    cache.close(); lines.close(); responses.close();
    for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(new Error("Codex stopped")); }
    pending.clear(); await cache.close(); await bridge.close();
  });
  return code;
}
