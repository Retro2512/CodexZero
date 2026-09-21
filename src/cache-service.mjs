import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { codexZeroHome } from "./paths.mjs";
import { DEFAULT_CACHE_SETTINGS, warmth } from "./cache-accounting.mjs";

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
  return readJson(path.join(cacheDirectory(home), "settings.json"), { ...DEFAULT_CACHE_SETTINGS, overrides: {}, activity: {} });
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
export async function readCacheSnapshot(id, home) {
  const settings = await readCacheSettings(home);
  const snapshot = id == null ? null : await readJson(path.join(cacheDirectory(home), `${validateThreadId(id)}.json`), null);
  const override = settings.overrides?.[id] ?? null;
  return { settings: { enabled: settings.enabled, minutes: settings.minutes }, override,
    enabled: override ?? settings.enabled, warmth: warmth(snapshot),
    cost: snapshot?.cost ?? { usd: null, uncachedUsd: null, partial: false }, error: snapshot?.error ?? null };
}
