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

export function priceUsage(model, value, tier = "default") {
  const usage = normalizeUsage(value);
  const price = MODEL_PRICING[model];
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
  return { usd: (input + output) / 1e6, uncachedUsd: (usage.input * rate.input * inMultiplier + output) / 1e6 };
}

export function cacheWindowMs(model) {
  if (!MODEL_PRICING[model]) return null;
  // The app server exposes no retention policy or expiry. These are deliberately
  // estimates: new explicit caching uses 30m, legacy unknown policy uses 5m.
  return /^(gpt-6-astra|gpt-5\.6-|gpt-5\.5$|gpt-daybreak-blue-latest$)/.test(model) ? 30 * MINUTE : 5 * MINUTE;
}

export function warmth(snapshot, now = Date.now()) {
  const window = cacheWindowMs(snapshot?.model);
  if (!window || !snapshot?.lastCacheAt || snapshot.invalidated) return { state: "unknown", remainingMs: null, estimated: true };
  const remainingMs = Math.max(0, Math.min(window, snapshot.lastCacheAt + window - now));
  return { state: remainingMs === 0 ? "cold" : remainingMs <= Math.min(2 * MINUTE, window / 3) ? "cooling" : "warm", remainingMs, estimated: true };
}

export function shouldKeepWarm(snapshot, settings, now = Date.now()) {
  const enabled = settings.overrides?.[snapshot.id] ?? settings.enabled;
  const activity = Math.max(snapshot.lastUserAt || 0, settings.activity?.[snapshot.id] || 0);
  const heat = warmth(snapshot, now);
  return enabled === true && !snapshot.active && !snapshot.blocked && !snapshot.error &&
    activity > 0 && now >= activity + MINUTE && now < activity + settings.minutes * MINUTE &&
    heat.remainingMs != null && heat.remainingMs > 0 && heat.remainingMs <= MINUTE &&
    (!snapshot.lastAttemptAt || now - snapshot.lastAttemptAt >= MINUTE);
}

/** Aggregate only usage records. Never retain message bodies, instructions or tools. */
export class ConversationAccounting {
  constructor(id) {
    this.snapshot = { id, model: null, lastCacheAt: null, lastUserAt: null, invalidated: false,
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
    const exact = Object.keys(total).every(k => total[k] - (previous?.[k] ?? 0) === last[k]);
    // Compaction can reset or synthesize totals without a billable request.
    if (previous && Object.keys(total).some(k => total[k] < previous[k])) { state.invalidated = true; return; }
    if (!exact) state.cost.partial = true;
    if (!exact && previous) return;
    if (!last.input && !last.output) return;
    const cost = priceUsage(state.model, p.info.last_token_usage, this.tier);
    state.requests++;
    if (cost) {
      state.pricedRequests++;
      state.cost.usd += cost.usd;
      state.cost.uncachedUsd += cost.uncachedUsd;
    } else state.cost.partial = true;
    // Only an observed cache read or write is evidence of a warm prefix.
    if (last.read > 0 || last.write > 0) { state.lastCacheAt = at; state.invalidated = false; }
    else { state.invalidated = true; }
  }
}
