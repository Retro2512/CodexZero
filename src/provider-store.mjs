import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { codexZeroHome } from "./paths.mjs";

const FILE_NAME = "providers.json";
const API_TYPES = new Set(["responses", "chat", "anthropic"]);
const ID_PATTERN = /^[a-z0-9_]+$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_OUTPUT_TOKENS = 1_000_000;
const writes = new Map();

function fail(message) {
  throw new TypeError(message);
}

function text(value, field, maximum) {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail(`${field} is required`);
  if (normalized.length > maximum) fail(`${field} is too long`);
  return normalized;
}

function loopback(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return Boolean(match && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255));
}

function baseUrl(value, index) {
  const raw = text(value, `Provider ${index + 1} baseUrl`, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`Provider ${index + 1} baseUrl must be a valid URL`);
  }
  if (url.username || url.password) fail(`Provider ${index + 1} baseUrl cannot contain credentials`);
  if (url.search || url.hash) fail(`Provider ${index + 1} baseUrl cannot contain a query or fragment`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    fail(`Provider ${index + 1} baseUrl must use HTTPS or loopback HTTP`);
  }
  return { value: url.toString().replace(/\/$/, ""), local: loopback(url.hostname) };
}

function normalizeProvider(provider, index) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    fail(`Provider ${index + 1} must be an object`);
  }

  const allowed = new Set([
    "id", "name", "apiType", "baseUrl", "model", "apiKeyEnv", "maxOutputTokens", "enabled",
  ]);
  for (const key of Object.keys(provider)) {
    if (!allowed.has(key)) fail(`Provider ${index + 1} contains an unsupported field`);
  }

  const id = text(provider.id, `Provider ${index + 1} id`, 64);
  if (provider.id !== id || !ID_PATTERN.test(id)) fail(`Provider ${index + 1} id must contain only lowercase letters, numbers, and underscores`);
  const name = text(provider.name, `Provider ${index + 1} name`, 100);
  if (!API_TYPES.has(provider.apiType)) fail(`Provider ${index + 1} apiType is invalid`);
  const endpoint = baseUrl(provider.baseUrl, index);
  const model = text(provider.model, `Provider ${index + 1} model`, 256);

  const apiKeyEnv = provider.apiKeyEnv === undefined ? "" : provider.apiKeyEnv;
  if (typeof apiKeyEnv !== "string" || apiKeyEnv !== apiKeyEnv.trim() || apiKeyEnv.length > 128) {
    fail(`Provider ${index + 1} apiKeyEnv is invalid`);
  }
  if (apiKeyEnv && !ENV_PATTERN.test(apiKeyEnv)) fail(`Provider ${index + 1} apiKeyEnv is invalid`);

  const maxOutputTokens = provider.maxOutputTokens === undefined ? 4096 : provider.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    fail(`Provider ${index + 1} maxOutputTokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`);
  }
  const enabled = provider.enabled === undefined ? true : provider.enabled;
  if (typeof enabled !== "boolean") fail(`Provider ${index + 1} enabled must be a boolean`);

  return {
    id,
    name,
    apiType: provider.apiType,
    baseUrl: endpoint.value,
    model,
    apiKeyEnv,
    maxOutputTokens,
    enabled,
  };
}

export function validateProviders(providers) {
  if (!Array.isArray(providers)) fail("Providers must be an array");
  if (providers.length > 100) fail("At most 100 providers are supported");
  const normalized = providers.map(normalizeProvider);
  const ids = new Set();
  const names = new Set();
  for (const provider of normalized) {
    const name = provider.name.toLowerCase();
    if (ids.has(provider.id)) fail(`Provider id ${provider.id} is duplicated`);
    if (names.has(name)) fail(`Provider name ${provider.name} is duplicated`);
    ids.add(provider.id);
    names.add(name);
  }
  return normalized;
}

export async function readProviders(home = codexZeroHome()) {
  const file = path.join(home, FILE_NAME);
  let source;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let document;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("providers.json is not valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document) || document.version !== 1) {
    throw new Error("providers.json has an unsupported format");
  }
  if (Object.keys(document).some((key) => key !== "version" && key !== "providers")) {
    throw new Error("providers.json has an unsupported format");
  }
  return validateProviders(document.providers);
}

async function writeProviders(providers, home) {
  const normalized = validateProviders(providers);
  await fs.mkdir(home, { recursive: true });
  const destination = path.join(home, FILE_NAME);
  const temporary = path.join(home, `.${FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const bytes = `${JSON.stringify({ version: 1, providers: normalized }, null, 2)}\n`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600).catch((error) => {
      if (process.platform !== "win32") throw error;
    });
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return normalized;
}

export function saveProviders(providers, home = codexZeroHome()) {
  const key = path.resolve(home);
  const previous = writes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => writeProviders(providers, key));
  writes.set(key, current);
  current.finally(() => {
    if (writes.get(key) === current) writes.delete(key);
  }).catch(() => {});
  return current;
}
