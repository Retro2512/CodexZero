import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { validateIdentityPatch } from "./sidebar-identity-schema.mjs";

const FIELDS = ["color", "palette", "tone", "category", "iconMode", "drawing", "image", "customThreadIcons", "name"];
const ORIGINS = new Set(["manual", "automatic"]);
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;

function validKey(key) {
  if (typeof key !== "string" || !key || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeError("Identity key is invalid");
  }
  return key;
}

function fresh() { return { version: 1, revision: 0, records: Object.create(null) }; }
function clone(value) { return structuredClone(value); }

function validateFile(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
    data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
    !data.records || typeof data.records !== "object" || Array.isArray(data.records) ||
    Object.keys(data).some(key => !["version", "revision", "records"].includes(key))) {
    throw new TypeError("Identity store file is invalid");
  }
  const records = Object.create(null);
  for (const [key, record] of Object.entries(data.records)) {
    validKey(key);
    if (!record || typeof record !== "object" || Array.isArray(record) ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 || record.revision > data.revision ||
      !Number.isFinite(record.updatedAt) || record.updatedAt < 0 ||
      !record.origins || typeof record.origins !== "object" || Array.isArray(record.origins)) {
      throw new TypeError("Identity store record is invalid");
    }
    const fields = {};
    for (const field of FIELDS) if (Object.hasOwn(record, field)) fields[field] = record[field];
    const normalized = validateIdentityPatch(fields);
    if (Object.keys(record).some(field => !FIELDS.includes(field) && !["revision", "updatedAt", "origins"].includes(field)) ||
      Object.keys(record.origins).some(field => !Object.hasOwn(normalized, field) || !ORIGINS.has(record.origins[field]))) {
      throw new TypeError("Identity store record contains unsupported data");
    }
    if (Object.keys(normalized).some(field => !Object.hasOwn(record.origins, field))) throw new TypeError("Identity store origin is missing");
    records[key] = { ...normalized, revision: record.revision, updatedAt: record.updatedAt, origins: { ...record.origins } };
  }
  return { version: 1, revision: data.revision, records };
}

async function read(file) {
  let source;
  try { source = await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return fresh(); throw error; }
  return validateFile(JSON.parse(source));
}

async function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function recoverStaleLock(file) {
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (Date.now() - stat.mtimeMs < STALE_LOCK_MS) return;
  let owner;
  try { owner = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return; owner = null; }
  if (owner?.host === os.hostname() && await ownerAlive(owner.pid)) return;
  // Confirm this is still the stale inode before unlinking a lock another writer replaced.
  let current;
  try { current = await fs.stat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) {
    try { await fs.unlink(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

async function acquire(file) {
  const started = Date.now();
  const token = crypto.randomUUID();
  for (;;) {
    try {
      const handle = await fs.open(file, "wx", 0o600);
      let wrote = false;
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), token }));
        wrote = true;
      } finally {
        await handle.close();
        if (!wrote) await fs.rm(file, { force: true });
      }
      return async () => {
        try {
          const owner = JSON.parse(await fs.readFile(file, "utf8"));
          if (owner.token === token) await fs.unlink(file);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
      await recoverStaleLock(file);
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error("Identity store lock timed out");
      await new Promise(resolve => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)));
    }
  }
}

async function atomicWrite(file, data) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 20 || !["EPERM", "EACCES"].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 + attempt * 5));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export class IdentityStore {
  constructor(file) {
    if (typeof file !== "string" || !file) throw new TypeError("Identity store file is required");
    this.file = file;
    this.data = null;
    this.loading = null;
    this.queue = Promise.resolve();
    this.listeners = new Set();
  }

  async #load() {
    if (!this.data) {
      this.loading ??= read(this.file).then(data => { this.data = data; return data; })
        .finally(() => { this.loading = null; });
      await this.loading;
    }
    return this.data;
  }

  async snapshot() { return clone(await this.#load()); }

  async get(key) {
    validKey(key);
    const data = await this.#load();
    return Object.hasOwn(data.records, key) ? clone(data.records[key]) : null;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(key, patch, { origin = "manual", expectedRevision, onlyMissing = false } = {}) {
    validKey(key);
    const normalized = validateIdentityPatch(patch);
    if (!ORIGINS.has(origin)) throw new TypeError("Identity origin is invalid");
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw new TypeError("Expected revision is invalid");
    }
    if (typeof onlyMissing !== "boolean") throw new TypeError("onlyMissing must be boolean");
    const job = this.queue.catch(() => {}).then(async () => {
      await this.#load();
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const release = await acquire(`${this.file}.lock`);
      let result;
      let changed = false;
      try {
        // Reload under the interprocess lock; cached reads must never drive writes.
        const data = await read(this.file);
        const previous = Object.hasOwn(data.records, key) ? data.records[key] : null;
        if (expectedRevision !== undefined && expectedRevision !== (previous?.revision ?? 0)) {
          this.data = data;
          return previous ? clone(previous) : null;
        }
        const next = previous ? clone(previous) : { origins: {} };
        for (const [field, value] of Object.entries(normalized)) {
          if (onlyMissing && Object.hasOwn(next, field)) continue;
          if (origin === "automatic" && next.origins[field] === "manual") continue;
          if (Object.hasOwn(next, field) && JSON.stringify(next[field]) === JSON.stringify(value) && next.origins[field] === origin) continue;
          next[field] = value;
          next.origins[field] = origin;
          changed = true;
        }
        if (!changed) {
          this.data = data;
          return previous ? clone(previous) : null;
        }
        next.revision = data.revision + 1;
        next.updatedAt = Date.now();
        data.revision = next.revision;
        data.records[key] = next;
        await atomicWrite(this.file, data);
        this.data = data;
        result = clone(next);
      } finally { await release(); }
      if (changed) for (const listener of this.listeners) {
        try { listener(key, clone(result)); } catch { /* Observers cannot roll back a committed update. */ }
      }
      return result;
    });
    this.queue = job;
    return job;
  }
}
