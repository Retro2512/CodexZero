import fs from "node:fs/promises";
import path from "node:path";
import { ConversationAccounting, KEEP_WARM_MESSAGE, shouldKeepWarm } from "./cache-accounting.mjs";
import { atomicJson, cacheDirectory, readCacheSettings, readJson, validateThreadId } from "./cache-service.mjs";

/** Incremental bounded reader; message content is discarded immediately. */
export class CacheRolloutReader {
  constructor(id, file) { this.id = id; this.file = file; this.turnHints = {}; this.reset(); }
  reset() { this.offset = 0; this.pending = Buffer.alloc(0); this.accounting = new ConversationAccounting(this.id); }
  async read() {
    const handle = await fs.open(this.file, "r");
    try {
      const stat = await handle.stat();
      if (this.identity !== `${stat.dev}:${stat.ino}` || stat.size < this.offset) this.reset();
      this.identity = `${stat.dev}:${stat.ino}`;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const bytes = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
          if (!this.skipping) {
            try {
              const record = JSON.parse(bytes.subarray(start, end).toString("utf8"));
              const hint = record.type === "turn_context" && this.turnHints[record.payload?.turn_id];
              if (hint) record.payload = { ...record.payload, service_tier: hint.tier, model: hint.model ?? record.payload.model };
              this.accounting.accept(record);
            }
            catch { this.accounting.snapshot.cost.partial = true; }
          }
          this.skipping = false;
          start = end + 1;
        }
        this.pending = Buffer.from(bytes.subarray(start));
        if (this.pending.length > 4 * 1024 * 1024) { this.pending = Buffer.alloc(0); this.skipping = true; }
      }
      return this.accounting.snapshot;
    } finally { await handle.close(); }
  }
}

export class CacheMonitor {
  constructor({ home, rpc, isBusy, enqueue, now = Date.now }) {
    Object.assign(this, { home, rpc, isBusy, enqueue, now });
    this.threads = new Map(); this.warming = new Map(); this.running = false; this.closed = false;
    this.cleanups = new Set();
  }
  remember(result) {
    const thread = result?.thread;
    if (!thread?.id || !thread.path || thread.parentThreadId || thread.ephemeral) return;
    validateThreadId(thread.id);
    let entry = this.threads.get(thread.id);
    if (!entry || entry.file !== thread.path) {
      entry = { file: thread.path, reader: new CacheRolloutReader(thread.id, thread.path), active: thread.status?.type === "active" };
      this.threads.set(thread.id, entry);
    }
    entry.model = result.model ?? thread.model;
    if (Object.hasOwn(result, "serviceTier")) entry.tier = result.serviceTier;
    entry.provider = result.modelProvider ?? thread.modelProvider;
    entry.loaded = thread.status?.type !== "notLoaded";
    void this.tick();
  }
  userActivity(id) {
    const entry = this.threads.get(id);
    if (entry) { entry.lastUserAt = this.now(); entry.error = null; }
  }
  select(id, params, model) {
    const entry = this.threads.get(id);
    if (!entry) return;
    entry.model = model;
    if (Object.hasOwn(params, "serviceTier")) entry.tier = params.serviceTier;
    entry.turnTier = params.serviceTierForTurn ?? entry.tier ?? null;
  }
  notify(message) {
    if (this.closed) return;
    const p = message.params;
    const id = p?.threadId ?? p?.thread?.id;
    const entry = this.threads.get(id);
    if (!entry) return;
    if (message.method === "turn/started") {
      entry.active = true;
      if (p.turn?.id) {
        const hint = { tier: entry.turnTier ?? entry.tier ?? null, model: entry.model };
        entry.hintQueue = (entry.hintQueue ?? Promise.resolve()).catch(() => {}).then(async () => {
          const file = path.join(cacheDirectory(this.home), `${id}.turns.json`);
          const hints = await readJson(file, {});
          hints[p.turn.id] = hint;
          await atomicJson(file, hints);
        });
        void entry.hintQueue.catch(() => {});
      }
    }
    if (message.method === "turn/completed") {
      entry.active = false;
      if (this.warming.has(id)) {
        if (p.turn?.status !== "completed") entry.error = "Refresh paused";
        this.warming.get(id).resolve(); this.warming.delete(id);
      } else entry.lastUserAt = this.now();
    }
    if (["thread/closed", "thread/archived", "thread/deleted"].includes(message.method)) entry.loaded = false;
    if (message.method === "thread/status/changed") entry.active = p.status?.type === "active";
    if (message.method === "error") entry.error = "Refresh paused";
    if (message.method === "model/rerouted") { entry.rerouted = true; entry.error = "Refresh paused"; }
    if (message.method === "thread/compacted" || message.method === "model/rerouted") entry.reader.accounting.snapshot.invalidated = true;
  }
  async cancel(id) {
    const warm = this.warming.get(id);
    if (!warm) return;
    if (!warm.turnId) await warm.started;
    if (!this.warming.has(id)) return;
    await this.rpc("turn/interrupt", { threadId: id, turnId: warm.turnId });
    let timer;
    try { await Promise.race([warm.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Wait for the cache refresh to finish")), 15000); })]); }
    finally { clearTimeout(timer); }
    await warm.cleanup;
  }
  start() { this.timer = setInterval(() => void this.tick(), 5000); this.timer.unref?.(); }
  tick() {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.tickWork;
    this.running = true;
    this.tickWork = this.observe().finally(() => { this.running = false; });
    return this.tickWork;
  }
  async observe() {
    try {
      const settings = await readCacheSettings(this.home);
      for (const [id, entry] of this.threads) {
        if (this.closed) break;
        try {
          await entry.hintQueue;
          entry.reader.turnHints = await readJson(path.join(cacheDirectory(this.home), `${id}.turns.json`), {});
          const raw = await entry.reader.read();
          const snapshot = { ...raw, model: entry.model ?? raw.model, active: entry.active,
            lastUserAt: Math.max(raw.lastUserAt || 0, entry.lastUserAt || 0),
            lastAttemptAt: entry.lastAttemptAt, error: entry.error ?? null };
          if (snapshot.model !== raw.model || entry.provider !== "openai") snapshot.invalidated = true;
          if (entry.rerouted) { snapshot.invalidated = true; snapshot.cost = { ...raw.cost, partial: true }; }
          if (raw.requests > 0 && raw.pricedRequests === 0) snapshot.cost = { usd: null, uncachedUsd: null, partial: true };
          await atomicJson(path.join(cacheDirectory(this.home), `${id}.json`), snapshot);
          if (entry.loaded && entry.provider === "openai" && !this.isBusy(id) && shouldKeepWarm(snapshot, settings, this.now())) {
            await this.enqueue(id, async () => {
              // Recheck after queueing and after I/O. Never turn a refresh into steering.
              if (this.closed || this.isBusy(id) || !entry.loaded) return;
              const fresh = await readCacheSettings(this.home);
              if (!shouldKeepWarm(snapshot, fresh, this.now())) return;
              const current = await this.rpc("thread/read", { threadId: id, includeTurns: false });
              if (this.isBusy(id) || current.thread?.status?.type !== "idle" || current.thread?.model !== snapshot.model) return;
              const leasePath = path.join(cacheDirectory(this.home), `${id}.lease`);
              let lease;
              try { lease = await fs.open(leasePath, "wx"); await lease.writeFile(JSON.stringify({ pid: process.pid })); }
              catch (error) {
                if (error.code !== "EEXIST") throw error;
                // A crashed app must not disable refresh forever. Never take a
                // lease from a live or unidentifiable process.
                const owner = await readJson(leasePath, null);
                if (Number.isInteger(owner?.pid) && owner.pid > 0) {
                  try { process.kill(owner.pid, 0); }
                  catch (failure) { if (failure.code === "ESRCH") await fs.rm(leasePath, { force: true }); }
                }
                return;
              }
              try {
                // The lease is released after completion, across all app windows.
                const latest = await readCacheSettings(this.home);
                if (this.closed || this.isBusy(id) || !shouldKeepWarm(snapshot, latest, this.now())) return;
                const attemptFile = path.join(cacheDirectory(this.home), `${id}.refresh.json`);
                const lastAttempt = await readJson(attemptFile, null);
                if (lastAttempt?.at && this.now() - lastAttempt.at < 60_000) return;
                entry.lastAttemptAt = this.now();
                await atomicJson(attemptFile, { at: entry.lastAttemptAt });
                // One-off tier overrides from a user turn are not inherited.
                entry.turnTier = entry.tier ?? null;
                let resolve, startedResolve;
                const done = new Promise(r => { resolve = r; });
                const started = new Promise(r => { startedResolve = r; });
                const warm = { done, resolve, started, turnId: null };
                this.warming.set(id, warm);
                try {
                  const result = await this.rpc("turn/start", { threadId: id, input: [{ type: "text", text: KEEP_WARM_MESSAGE, text_elements: [] }] });
                  warm.turnId = result.turn?.id;
                  startedResolve();
                  // Do not hold the per-task request queue while the model runs.
                  const heldLease = lease;
                  warm.cleanup = done.finally(async () => { await heldLease.close(); await fs.rm(leasePath, { force: true }); });
                  this.cleanups.add(warm.cleanup);
                  void warm.cleanup.finally(() => this.cleanups.delete(warm.cleanup)).catch(() => {});
                  lease = null;
                } catch (error) {
                  startedResolve(); resolve(); this.warming.delete(id); entry.error = "Refresh paused";
                  throw error;
                }
              } finally {
                if (lease) { await lease.close(); await fs.rm(leasePath, { force: true }); }
              }
            });
          }
        } catch { entry.error = "Refresh paused"; }
      }
    } catch { /* Unreadable settings disable refreshes rather than sending traffic. */ }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const warm of this.warming.values()) warm.resolve();
    this.warming.clear();
    await this.tickWork;
    await Promise.allSettled([...this.cleanups, ...[...this.threads.values()].map(entry => entry.hintQueue)]);
  }
}
