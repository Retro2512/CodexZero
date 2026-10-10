import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readProviders } from "./provider-store.mjs";
import { PROVIDER_BODY_LIMIT, serveProviderResponse } from "./provider-adapters.mjs";
import { findProvider } from "./provider-router.mjs";
import { getProviderKey } from "./provider-secrets.mjs";
import { recordProviderUsageVersion } from "./provider-pricing.mjs";
import { discovery } from "./provider-rtk.mjs";
import { createProviderUsageLedger } from "./provider-usage-ledger.mjs";

export async function startProviderBridge({ home, environment = process.env } = {}) {
  await recordProviderUsageVersion(home);
  const rtkRuntime = discovery({ environment });
  const ledger = createProviderUsageLedger({ home, environment });
  const discoveries = new Map();
  let ledgerFailureReported = false;
  const recordAttempt = async record => {
    try { await ledger.recordAttempt(record); }
    catch {
      if (!ledgerFailureReported) process.stderr.write("CodexZero could not record provider usage\n");
      ledgerFailureReported = true;
    }
  };
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${token}`);
    const reject = (status, message) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    };
    if (req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return reject(403, "Not authorized");
    }
    if (req.method !== "POST" || req.url !== "/v1/responses") return reject(404, "Not found");
    try {
      // Peek the model without exposing incoming authentication to the adapter.
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > PROVIDER_BODY_LIMIT) return reject(413, "Request is too large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let payload;
      try { payload = JSON.parse(body); } catch { return reject(400, "Invalid request"); }
      const provider = findProvider(await readProviders(home), payload.model);
      if (!provider) return reject(400, "Select a custom model");
      const apiKey = await getProviderKey(provider, home, environment);
      if (provider.apiKeyEnv && !apiKey) return reject(400, `Set ${provider.apiKeyEnv} before launching Codex`);
      // Replay only the body. The adapter must not see Codex or local bearer tokens.
      const { Readable } = await import("node:stream");
      const replay = Readable.from([body]);
      replay.headers = { "content-type": "application/json" };
      res.once("close", () => { if (!res.writableEnded) replay.destroy(); });
      const candidate = req.headers["thread-id"] ?? req.headers["session-id"];
      const threadId = typeof candidate === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : undefined;
      const discoveryKey = threadId ? `${provider.id}/${threadId}` : undefined;
      let discoveryState;
      if (discoveryKey) {
        const now = Date.now();
        for (const [key, value] of discoveries) if (now - value.lastUsed > 60 * 60 * 1000) discoveries.delete(key);
        let state = discoveries.get(discoveryKey);
        if (!state) { state = { loaded: new Set(), lastUsed: now }; discoveries.set(discoveryKey, state); }
        state.lastUsed = now; discoveryState = state.loaded;
      }
      await serveProviderResponse(replay, res, { provider, apiKey, rtkRuntime, recordAttempt, threadId, discoveryState });
    } catch {
      if (!res.headersSent) reject(502, "The custom provider request failed");
      else res.end();
    }
  });
  server.requestTimeout = 330000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
