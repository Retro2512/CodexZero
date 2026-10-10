import fs from "node:fs/promises";
import path from "node:path";
import { codexZeroHome } from "./paths.mjs";

const API_TYPES = new Set(["responses", "chat", "anthropic"]);
const STATUSES = new Set(["completed", "empty", "output_limit", "content_filter", "http_error", "invalid_response", "timeout", "cancelled", "error"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(field) {
  throw new TypeError(`Invalid provider usage ${field}`);
}

function count(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) fail(field);
  return value;
}

function boundedId(value, field, pattern, limit) {
  if (typeof value !== "string" || value.length < 1 || value.length > limit || !pattern.test(value)) fail(field);
  return value;
}

function normalizedUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("usage");
  const input = count(value.input_tokens, "usage.input_tokens");
  const cached = count(value.input_tokens_details?.cached_tokens, "usage.input_tokens_details.cached_tokens");
  const write = count(value.input_tokens_details?.cache_write_tokens, "usage.input_tokens_details.cache_write_tokens");
  const output = count(value.output_tokens, "usage.output_tokens");
  const reasoning = count(value.output_tokens_details?.reasoning_tokens, "usage.output_tokens_details.reasoning_tokens");
  const total = count(value.total_tokens, "usage.total_tokens");
  if (cached + write > input || reasoning > output || input + output !== total || !Number.isSafeInteger(input + output)) fail("usage totals");
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: total,
  };
}

function validatedPrices(pricing) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return null;
  const prices = [pricing.input, pricing.read, pricing.output, pricing.write ?? pricing.input];
  if (!prices.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000)) return null;
  return prices;
}

function estimatedCostUsd(usage, pricing) {
  if (!usage) return null;
  const prices = validatedPrices(pricing);
  if (!prices) return null;
  const [inputRate, readRate, outputRate, writeRate] = prices;
  const cached = usage.input_tokens_details.cached_tokens;
  const write = usage.input_tokens_details.cache_write_tokens;
  return ((usage.input_tokens - cached - write) * inputRate + cached * readRate + write * writeRate
    + usage.output_tokens * outputRate) / 1_000_000;
}

function estimatedUncachedCostUsd(usage, pricing) {
  if (!usage) return null;
  const prices = validatedPrices(pricing);
  if (!prices) return null;
  const [inputRate, , outputRate] = prices;
  return (usage.input_tokens * inputRate + usage.output_tokens * outputRate) / 1_000_000;
}

function requestMetrics(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail("requestMetrics");
  const messageBytes = value.messageBytes;
  if (!messageBytes || typeof messageBytes !== "object" || Array.isArray(messageBytes)) fail("requestMetrics.messageBytes");
  return {
    messageCount: count(value.messageCount, "requestMetrics.messageCount"),
    toolCount: count(value.toolCount, "requestMetrics.toolCount"),
    toolSchemaBytes: count(value.toolSchemaBytes, "requestMetrics.toolSchemaBytes"),
    messageBytes: {
      developer: count(messageBytes.developer, "requestMetrics.messageBytes.developer"),
      user: count(messageBytes.user, "requestMetrics.messageBytes.user"),
      assistant: count(messageBytes.assistant, "requestMetrics.messageBytes.assistant"),
      tool: count(messageBytes.tool, "requestMetrics.messageBytes.tool"),
    },
  };
}

function entry(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail("record");
  const timestamp = record.timestamp ?? new Date().toISOString();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) fail("timestamp");
  const requestId = boundedId(record.requestId, "requestId", /^[A-Za-z0-9_-]+$/, 128);
  const attempt = count(record.attempt, "attempt");
  if (attempt === 0) fail("attempt");
  const providerId = boundedId(record.providerId, "providerId", /^[a-z0-9_]+$/, 64);
  if (!API_TYPES.has(record.apiType)) fail("apiType");
  if (!STATUSES.has(record.status)) fail("status");
  const latencyMs = count(record.latencyMs, "latencyMs");
  if (typeof record.usageKnown !== "boolean") fail("usageKnown");
  if (!record.usageKnown && record.usage != null) fail("usage");
  const usage = record.usageKnown ? normalizedUsage(record.usage) : null;
  const includedInCoreUsage = record.includedInCoreUsage ?? null;
  if (includedInCoreUsage !== null && typeof includedInCoreUsage !== "boolean") fail("includedInCoreUsage");
  const threadId = record.threadId;
  if (threadId != null && (typeof threadId !== "string" || !UUID.test(threadId))) fail("threadId");
  return {
    schemaVersion: 1,
    timestamp,
    requestId,
    attempt,
    providerId,
    apiType: record.apiType,
    ...(threadId != null ? { threadId } : {}),
    status: record.status,
    latencyMs,
    usageKnown: record.usageKnown,
    usage,
    includedInCoreUsage,
    requestMetrics: requestMetrics(record.requestMetrics),
    estimatedCostUsd: estimatedCostUsd(usage, record.pricing),
    estimatedUncachedCostUsd: estimatedUncachedCostUsd(usage, record.pricing),
  };
}

export function createProviderUsageLedger({ home, environment = process.env } = {}) {
  const directory = home ?? codexZeroHome(environment);
  if (typeof directory !== "string" || !directory) fail("home");
  const file = path.join(directory, "provider-usage.jsonl");
  let pending = Promise.resolve();
  return {
    async recordAttempt(record) {
      const line = `${JSON.stringify(entry(record))}\n`;
      const write = pending.then(async () => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const handle = await fs.open(file, "a", 0o600);
        try {
          if (process.platform !== "win32") await handle.chmod(0o600);
          await handle.writeFile(line);
        } finally {
          await handle.close();
        }
      });
      // A failed append rejects its caller but does not poison later attempts.
      pending = write.catch(() => {});
      return write;
    },
  };
}
