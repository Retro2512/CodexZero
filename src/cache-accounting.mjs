import fs from "node:fs/promises";

import { MODEL_PRICING } from "../assets/model-pricing.mjs";

export const KEEP_WARM_MESSAGE = 'Ignore this message - Reply Only "OK"';
export const MINUTE = 60_000;
export const DEFAULT_CACHE_SETTINGS = Object.freeze({ enabled: false, minutes: 30 });

export function normalizeUsage(value) {
  if (!value) return null;
  const get = (camel, snake) => value[camel] ?? value[snake];
  const usage = {
    input: get("inputTokens", "input_tokens"), read: get("cachedInputTokens", "cached_input_tokens"),
    write: get("cacheWriteInputTokens", "cache_write_input_tokens") ?? 0,
    output: get("outputTokens", "output_tokens"),
  };
  return Object.values(usage).every(n => Number.isSafeInteger(n) && n >= 0) ? usage : null;
}

export function priceUsage(model, value, tier = "default", providerPrices = {}) {
  const usage = normalizeUsage(value);
  const price = providerPrices[model] ?? MODEL_PRICING[model];
  if (!usage || !price || !["default", "auto", "priority", "fast", null, undefined].includes(tier)) return null;
  const rate = tier === "priority" || tier === "fast" ? price.priority : price;
  if (!rate) return null;
  const write = rate.write == null ? 0 : usage.write;
  if (usage.read + write > usage.input) return null;
  const long = price.longContextThreshold != null && usage.input > price.longContextThreshold;
  if (long && model === "gpt-5.5" && ["priority", "fast"].includes(tier)) return null;
  const inMultiplier = long ? price.longInputMultiplier ?? 1 : 1;
  const outMultiplier = long ? price.longOutputMultiplier ?? 1 : 1;
  const input = ((usage.input - usage.read - write) * rate.input + usage.read * rate.read + write * (rate.write ?? 0)) * inMultiplier;
  const output = usage.output * rate.output * outMultiplier;
  // Reasoning tokens are already included in output, never charged a second time.
  return { usd: (input + output) / 1e6, uncachedUsd: (usage.input * rate.input * inMultiplier + output) / 1e6,
    ...(price.label ? { label: price.label } : {}) };
}

export function cacheWindowMs(model) {
  if (!MODEL_PRICING[model]) return null;
  // The app server exposes no retention policy or expiry. These are deliberately
  // estimates: new explicit caching uses 30m, legacy unknown policy uses 5m.
  return /^(gpt-6-astra|gpt-5\.6-|gpt-5\.5$|gpt-daybreak-blue-latest$)/.test(model) ? 30 * MINUTE : 5 * MINUTE;
}

export function warmth(snapshot, now = Date.now()) {
  const window = cacheWindowMs(snapshot?.model);
  const coolingThresholdMs = window ? Math.min(2 * MINUTE, window / 3) : null;
  if (!window || !snapshot?.lastCacheAt || snapshot.invalidated) {
    return { state: "unknown", remainingMs: null, windowMs: window, coolingThresholdMs, estimated: true };
  }
  const remainingMs = Math.max(0, Math.min(window, snapshot.lastCacheAt + window - now));
  return { state: remainingMs === 0 ? "cold" : remainingMs <= coolingThresholdMs ? "cooling" : "warm",
    remainingMs, windowMs: window, coolingThresholdMs, estimated: true };
}

export function shouldKeepWarm(snapshot, settings, now = Date.now()) {
  const enabled = settings.overrides?.[snapshot.id] ?? settings.enabled;
  const activity = Math.max(snapshot.lastUserAt || 0, settings.activity?.[snapshot.id] || 0);
  const heat = warmth(snapshot, now);
  return enabled === true && !snapshot.active && !snapshot.blocked && !snapshot.error &&
    activity > 0 && now >= activity + MINUTE && now < activity + settings.minutes * MINUTE &&
    heat.remainingMs != null && heat.remainingMs > 0 && heat.remainingMs <= heat.coolingThresholdMs &&
    (!snapshot.lastAttemptAt || now - snapshot.lastAttemptAt >= MINUTE);
}

/** Aggregate only usage records. Never retain message bodies, instructions or tools. */
export class ConversationAccounting {
  constructor(id, providerPrices = {}) {
    this.providerPrices = providerPrices;
    this.snapshot = { id, cacheSchemaVersion: 2, model: null, lastCacheAt: null, lastUserAt: null, invalidated: false,
      lastObservedAt: null, firstRequestAt: null, lastRequestAt: null,
      cost: { usd: 0, uncachedUsd: 0, partial: false }, requests: 0, pricedRequests: 0 };
    this.total = null;
    this.tier = null;
    this.keepWarmTurn = false;
  }

  accept(record) {
    const { type, payload: p } = record;
    if (!p) return;
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) return;
    const state = this.snapshot;
    state.lastObservedAt = Math.max(state.lastObservedAt || 0, at);
    if (type === "turn_context") {
      const model = p.model ?? p.collaboration_mode?.settings?.model;
      if (model !== state.model) state.invalidated = true;
      state.model = model ?? null;
      this.tier = p.service_tier ?? null;
    }
    if (type === "compacted") state.invalidated = true;
    if (type === "response_item" && p.type === "message" && p.role === "user") {
      const text = (p.content ?? []).filter(x => x.type === "input_text").map(x => x.text).join("\n").trim();
      this.keepWarmTurn = text === KEEP_WARM_MESSAGE;
      if (!this.keepWarmTurn) state.lastUserAt = at;
    }
    if (type !== "event_msg") return;
    if (p.type === "user_message") {
      this.keepWarmTurn = p.message?.trim() === KEEP_WARM_MESSAGE;
      if (!this.keepWarmTurn) state.lastUserAt = at;
    }
    if (["task_complete", "task_completed"].includes(p.type) && !this.keepWarmTurn) state.lastUserAt = Math.max(state.lastUserAt || 0, at);
    if (p.type !== "token_count" || !p.info) return;
    const total = normalizeUsage(p.info.total_token_usage);
    const last = normalizeUsage(p.info.last_token_usage);
    if (!total || !last) { state.cost.partial = true; return; }
    if (this.total && Object.keys(total).every(k => total[k] === this.total[k])) return;
    const previous = this.total;
    this.total = total;
    // Cache evidence is useful even when a missed event prevents exact billing.
    // Duplicate cumulative updates returned above must not extend warmth.
    if (last.input || last.output || last.read || last.write) {
      state.firstRequestAt ??= at;
      state.lastRequestAt = at;
      // A first cacheable request primes its prefix even when Codex reports no
      // cached reads and omits cache writes. Estimate retention, not cache billing.
      const primesCache = last.input >= 1024 && cacheWindowMs(state.model) === 30 * MINUTE;
      if (last.read > 0 || last.write > 0 || primesCache) { state.lastCacheAt = at; state.invalidated = false; }
      else state.invalidated = true;
    }
    const exact = Object.keys(total).every(k => total[k] - (previous?.[k] ?? 0) === last[k]);
    // Compaction can reset or synthesize totals without a billable request.
    if (previous && Object.keys(total).some(k => total[k] < previous[k])) { state.invalidated = true; return; }
    if (!exact) state.cost.partial = true;
    if (!exact && previous) return;
    if (!last.input && !last.output) return;
    const cost = priceUsage(state.model, p.info.last_token_usage, this.tier, this.providerPrices);
    if (at < (this.providerPrices[state.model]?.cacheUsageSince ?? 0)) state.cost.partial = true;
    state.requests++;
    if (cost) {
      if (cost.label || state.cost.label) state.cost.label = state.pricedRequests === 0 ? cost.label :
        state.cost.label === cost.label ? cost.label : "API estimate";
      state.pricedRequests++;
      state.cost.usd += cost.usd;
      state.cost.uncachedUsd += cost.uncachedUsd;
    } else state.cost.partial = true;
  }
}

/** Incremental bounded reader; message content is discarded immediately. */
export class CacheRolloutReader {
  constructor(id, file) { this.id = id; this.file = file; this._turnHints = {}; this.reset(); }
  get turnHints() { return this._turnHints; }
  set providerPrices(value) {
    if (JSON.stringify(value) === JSON.stringify(this._providerPrices)) return;
    this._providerPrices = value;
    this.reset();
  }
  set turnHints(value) {
    const next = value && typeof value === "object" ? value : {};
    const keys = new Set([...Object.keys(this._turnHints ?? {}), ...Object.keys(next)]);
    const replay = [...keys].some(id => this.seenTurnIds?.has(id) &&
      JSON.stringify(this._turnHints?.[id]) !== JSON.stringify(next[id]));
    this._turnHints = next;
    if (replay) this.reset();
  }
  reset() {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.skipping = false;
    this.seenTurnIds = new Set();
    this.accounting = new ConversationAccounting(this.id, this._providerPrices);
  }
  async read() {
    const handle = await fs.open(this.file, "r");
    try {
      const stat = await handle.stat();
      if (this.identity !== `${stat.dev}:${stat.ino}` || stat.size < this.offset) this.reset();
      this.identity = `${stat.dev}:${stat.ino}`;
      this.observedSize = stat.size;
      this.modifiedAt = stat.mtimeMs;
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
              if (record.type === "turn_context" && record.payload?.turn_id) this.seenTurnIds.add(record.payload.turn_id);
              const hint = record.type === "turn_context" && this.turnHints[record.payload?.turn_id];
              if (hint) record.payload = { ...record.payload, service_tier: hint.tier, model: hint.model ?? record.payload.model };
              this.accounting.accept(record);
            } catch { this.accounting.snapshot.cost.partial = true; }
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
