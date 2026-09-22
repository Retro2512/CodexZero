import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { codexHome, codexZeroHome } from "./paths.mjs";
import { CacheRolloutReader, DEFAULT_CACHE_SETTINGS, warmth } from "./cache-accounting.mjs";
import { readProviderPricing } from "./provider-pricing.mjs";

const DISCOVERY_TTL_MS = 60_000;
const MISSING_DISCOVERY_TTL_MS = 10_000;
const discoveries = new Map();
const aggregates = new Map();

export function validateThreadId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new TypeError("Invalid task");
  return id;
}
export function cacheDirectory(home = codexZeroHome()) { return path.join(home, "context-cache"); }
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function readCacheSettings(home) {
  const defaults = { ...DEFAULT_CACHE_SETTINGS, overrides: {}, activity: {} };
  let value;
  try { value = await readJson(path.join(cacheDirectory(home), "settings.json"), defaults); }
  catch (error) { if (error instanceof SyntaxError) return defaults; throw error; }
  if (!value || typeof value !== "object") return defaults;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    minutes: Number.isInteger(value.minutes) && value.minutes >= 1 && value.minutes <= 1440 ? value.minutes : defaults.minutes,
    overrides: value.overrides && typeof value.overrides === "object" ? value.overrides : {},
    activity: value.activity && typeof value.activity === "object" ? value.activity : {},
  };
}
let writes = Promise.resolve();
function update(home, change) {
  const run = writes.then(async () => {
    const settings = await readCacheSettings(home);
    change(settings);
    await atomicJson(path.join(cacheDirectory(home), "settings.json"), settings);
    return settings;
  });
  writes = run.catch(() => {});
  return run;
}
export async function saveCacheSettings(value, home) {
  if (!value || typeof value.enabled !== "boolean" || !Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 1440 || Object.keys(value).some(k => !["enabled", "minutes"].includes(k))) throw new TypeError("Enter 1 to 1440 minutes");
  const settings = await update(home, s => { s.enabled = value.enabled; s.minutes = value.minutes; });
  return { enabled: settings.enabled, minutes: settings.minutes };
}
export async function setCacheEnabled(id, enabled, home) {
  validateThreadId(id);
  if (typeof enabled !== "boolean") throw new TypeError("Invalid setting");
  await update(home, s => { s.overrides ??= {}; s.overrides[id] = enabled; });
  return readCacheSnapshot(id, home);
}
export async function cacheActivity(id, home) {
  validateThreadId(id);
  await update(home, s => { s.activity ??= {}; s.activity[id] = Date.now(); });
}

async function walk(directory, visit) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file, visit);
    else if (entry.isFile()) await visit(file, entry.name);
  }));
}

async function sessionId(file) {
  const handle = await fs.open(file, "r");
  try {
    const limit = Math.min(1024 * 1024, (await handle.stat()).size);
    const bytes = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(bytes, 0, limit, 0);
    for (const line of bytes.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === "session_meta") return record.payload?.id ?? record.payload?.session_id ?? null;
    }
    return null;
  } finally { await handle.close(); }
}

async function rolloutFiles(id, home) {
  const resolvedHome = home ?? codexZeroHome();
  const root = path.resolve(resolvedHome) === path.resolve(codexZeroHome()) ?
    path.join(codexHome(), "sessions") : path.join(path.dirname(resolvedHome), "sessions");
  const key = `${root}\0${id}`;
  const cached = discoveries.get(key);
  const ttl = cached?.files.length ? DISCOVERY_TTL_MS : MISSING_DISCOVERY_TTL_MS;
  if (cached && Date.now() - cached.checkedAt < ttl) return cached.files;
  if (cached?.work) return cached.work;
  const entry = cached ?? { checkedAt: 0, files: [] };
  entry.work = (async () => {
    const candidates = [];
    await walk(root, async (file, name) => {
      if (name.endsWith(".jsonl") && name.includes(id)) candidates.push(file);
    });
    const files = [];
    for (const file of candidates) {
      try { if (await sessionId(file) === id) files.push(file); }
      catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
    files.sort();
    entry.checkedAt = Date.now(); entry.files = files;
    return files;
  })().finally(() => { entry.work = null; });
  discoveries.set(key, entry);
  return entry.work;
}

function combine(id, snapshots, partial = false) {
  if (!snapshots.length) return null;
  snapshots.sort((a, b) => (a.firstRequestAt || a.lastObservedAt || 0) - (b.firstRequestAt || b.lastObservedAt || 0));
  const selected = [];
  for (const snapshot of snapshots) {
    const previous = selected.at(-1);
    if (previous?.lastRequestAt && snapshot.firstRequestAt && snapshot.firstRequestAt <= previous.lastRequestAt) {
      // Resumed histories can be copied into a new rollout. Prefer the segment
      // that reaches further forward instead of charging the overlap twice.
      partial = true;
      if ((snapshot.lastRequestAt || 0) >= previous.lastRequestAt) selected[selected.length - 1] = snapshot;
    } else selected.push(snapshot);
  }
  const latest = selected.reduce((a, b) => (a.lastObservedAt || 0) > (b.lastObservedAt || 0) ? a : b);
  return {
    id,
    cacheSchemaVersion: latest.cacheSchemaVersion,
    model: latest.model,
    lastCacheAt: selected.reduce((value, item) => Math.max(value || 0, item.lastCacheAt || 0), 0) || null,
    lastUserAt: selected.reduce((value, item) => Math.max(value || 0, item.lastUserAt || 0), 0) || null,
    lastObservedAt: latest.lastObservedAt,
    invalidated: latest.invalidated,
    requests: selected.reduce((value, item) => value + item.requests, 0),
    pricedRequests: selected.reduce((value, item) => value + item.pricedRequests, 0),
    cost: {
      ...(latest.cost.label ? { label: selected.every(s => s.cost.label === latest.cost.label) ? latest.cost.label : "API estimate" } : {}),
      usd: selected.reduce((value, item) => value + item.cost.usd, 0),
      uncachedUsd: selected.reduce((value, item) => value + item.cost.uncachedUsd, 0),
      partial: partial || selected.some(item => item.cost.partial),
    },
  };
}

async function discoveredSnapshot(id, home) {
  const files = await rolloutFiles(id, home);
  if (!files.length) return null;
  const key = `${home ?? codexZeroHome()}\0${id}`;
  let state = aggregates.get(key);
  if (!state) { state = { readers: new Map() }; aggregates.set(key, state); }
  const work = (state.work ?? Promise.resolve()).catch(() => {}).then(async () => {
    let hints = {};
    let partial = false;
    try { hints = await readJson(path.join(cacheDirectory(home), `${id}.turns.json`), {}); }
    catch { partial = true; }
    const activeFiles = new Set(files);
    const providerPrices = await readProviderPricing(home);
    for (const file of state.readers.keys()) if (!activeFiles.has(file)) state.readers.delete(file);
    for (const file of files) {
      let reader = state.readers.get(file);
      if (!reader) { reader = new CacheRolloutReader(id, file); state.readers.set(file, reader); }
      reader.providerPrices = providerPrices;
      reader.turnHints = hints;
      try { await reader.read(); }
      catch (error) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
        partial = true;
      }
    }
    return combine(id, [...state.readers.values()].filter(reader => reader.accounting.snapshot.lastObservedAt)
      .map(reader => reader.accounting.snapshot), partial);
  });
  state.work = work;
  try { return await work; }
  finally { if (state.work === work) state.work = null; }
}

export async function readCacheSnapshot(id, home) {
  const settings = await readCacheSettings(home);
  let snapshot = null;
  if (id != null) {
    validateThreadId(id);
    let persisted = null;
    try { persisted = await readJson(path.join(cacheDirectory(home), `${id}.json`), null); }
    catch (error) { if (!(error instanceof SyntaxError) && !['EACCES', 'EPERM'].includes(error.code)) throw error; }
    let discovered = null;
    try { discovered = await discoveredSnapshot(id, home); } catch { /* A snapshot is still useful when history is inaccessible. */ }
    snapshot = discovered ?? persisted;
    if (snapshot && persisted) {
      const persistedIsCurrent = !discovered || (persisted.lastObservedAt || 0) >= (snapshot.lastObservedAt || 0);
      snapshot = { ...snapshot, active: persisted.active, lastAttemptAt: persisted.lastAttemptAt,
        error: persistedIsCurrent ? persisted.error ?? null : null };
      // A model selection or provider change can be newer than the rollout.
      if (persistedIsCurrent && persisted.model && persisted.model !== snapshot.model) {
        snapshot.model = persisted.model;
        snapshot.invalidated = true;
      } else if (persistedIsCurrent && (!discovered || persisted.cacheSchemaVersion >= 2 ||
        (persisted.lastObservedAt || 0) > (snapshot.lastObservedAt || 0))) {
        // Older monitors marked first cacheable requests invalid solely because
        // cached reads were zero. Replayed history supersedes that old decision.
        snapshot.invalidated ||= persisted.invalidated;
      }
    }
    if (snapshot?.requests > 0 && snapshot.pricedRequests === 0) {
      snapshot.cost = { usd: null, uncachedUsd: null, partial: true };
    }
  }
  const override = settings.overrides?.[id] ?? null;
  return { settings: { enabled: settings.enabled, minutes: settings.minutes }, override,
    keepWarmSupported: !snapshot?.model?.startsWith("custom/"),
    enabled: override ?? settings.enabled, warmth: warmth(snapshot),
    cost: snapshot?.cost ?? { usd: null, uncachedUsd: null, partial: false }, error: snapshot?.error ?? null };
}
