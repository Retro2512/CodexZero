import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexZeroHome } from "./paths.mjs";
import { readProviders, saveProviders, validateProviders } from "./provider-store.mjs";
import { hasProviderKey, providerKeyStorageSupported, updateProviderKeys } from "./provider-secrets.mjs";

const MAX_BODY_BYTES = 256 * 1024;
const HTML_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/provider-settings.html");

function secureHeaders(nonce) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function json(response, status, body, headers) {
  response.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function presentProviders(providers, home) {
  return Promise.all(providers.map(async (provider) => ({
    ...provider,
    apiKeyPresent: provider.apiKeyEnv ? Object.hasOwn(process.env, provider.apiKeyEnv) : false,
    directKeyPresent: await hasProviderKey(provider, home),
  })));
}

function isRemote(provider) {
  const host = new URL(provider.baseUrl).hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return false;
  return !/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

function authorized(value, token) {
  const actual = Buffer.from(value ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function body(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) {
    const error = new Error("Request body is too large");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

export async function startProviderSettings({ home = codexZeroHome(), port = 0 } = {}) {
  const template = await fs.readFile(HTML_PATH, "utf8");
  const token = crypto.randomBytes(32).toString("base64url");
  let expectedHost;
  let expectedOrigin;

  const server = http.createServer(async (request, response) => {
    const nonce = crypto.randomBytes(18).toString("base64url");
    const headers = secureHeaders(nonce);
    try {
      if (request.headers.host !== expectedHost) {
        json(response, 400, { error: "Invalid host" }, headers);
        return;
      }
      const requestUrl = new URL(request.url, expectedOrigin);
      if (requestUrl.origin !== expectedOrigin || requestUrl.search || requestUrl.hash) {
        json(response, 404, { error: "Not found" }, headers);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
        response.end(template.replaceAll("{{NONCE}}", nonce));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (requestUrl.pathname !== "/api/providers") {
        json(response, 404, { error: "Not found" }, headers);
        return;
      }

      const origin = request.headers.origin;
      if (origin !== undefined && origin !== expectedOrigin) {
        json(response, 403, { error: "Invalid origin" }, headers);
        return;
      }
      if (request.method !== "GET" && origin !== expectedOrigin) {
        json(response, 403, { error: "Invalid origin" }, headers);
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        json(response, 401, { error: "Unauthorized" }, headers);
        return;
      }

      if (request.method === "GET") {
        json(response, 200, {
          providers: await presentProviders(await readProviders(home), home),
          directKeySupported: providerKeyStorageSupported,
        }, headers);
        return;
      }
      if (request.method === "PUT") {
        if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          json(response, 415, { error: "Content type must be application/json" }, headers);
          return;
        }
        const document = await body(request);
        if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.providers)) {
          json(response, 400, { error: "Providers must be an array" }, headers);
          return;
        }
        if (Object.keys(document).some((key) => !["providers", "keys", "clearKeys"].includes(key))) {
          json(response, 400, { error: "Request contains an unsupported field" }, headers);
          return;
        }
        const keys = document.keys === undefined ? {} : document.keys;
        const clearKeys = document.clearKeys === undefined ? [] : document.clearKeys;
        if (!keys || typeof keys !== "object" || Array.isArray(keys) || !Array.isArray(clearKeys)) {
          json(response, 400, { error: "API keys are invalid" }, headers);
          return;
        }
        const providers = validateProviders(document.providers);
        const ids = new Set(providers.map((provider) => provider.id));
        if (Object.keys(keys).some((id) => !ids.has(id)) || clearKeys.some((id) => !ids.has(id))) {
          json(response, 400, { error: "API key provider is invalid" }, headers);
          return;
        }
        const existing = new Map(await Promise.all(providers.map(async (provider) => [provider.id, await hasProviderKey(provider, home)])));
        for (const provider of providers) {
          const willHaveDirectKey = providerKeyStorageSupported && (
            typeof keys[provider.id] === "string" && keys[provider.id].length > 0 ||
            existing.get(provider.id) && !clearKeys.includes(provider.id)
          );
          if (provider.enabled && isRemote(provider) && !provider.apiKeyEnv && !willHaveDirectKey) {
            json(response, 400, { error: `Provider ${provider.name} needs an API key` }, headers);
            return;
          }
        }
        await updateProviderKeys({ keys, clear: clearKeys, activeIds: [...ids] }, home);
        const saved = await saveProviders(providers, home);
        json(response, 200, {
          providers: await presentProviders(saved, home),
          directKeySupported: providerKeyStorageSupported,
        }, headers);
        return;
      }
      response.setHeader("Allow", "GET, PUT");
      json(response, 405, { error: "Method not allowed" }, headers);
    } catch (error) {
      const status = error.statusCode ?? (error instanceof TypeError ? 400 : 500);
      json(response, status, { error: status === 500 ? "Unable to load provider settings" : error.message }, headers);
    }
  });

  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });
  const address = server.address();
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;

  let closePromise;
  return {
    url: `${expectedOrigin}/#${token}`,
    close: () => {
      if (!closePromise) {
        closePromise = new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeIdleConnections?.();
        });
      }
      return closePromise;
    },
  };
}
