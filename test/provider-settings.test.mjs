import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readProviders, saveProviders } from "../src/provider-store.mjs";
import { startProviderSettings } from "../src/provider-settings.mjs";
import { getProviderKey, hasProviderKey, providerKeyStorageSupported, updateProviderKeys } from "../src/provider-secrets.mjs";

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codexzero-provider-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function provider(overrides = {}) {
  return {
    id: "local_model",
    name: "Local model",
    apiType: "responses",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "model-name",
    apiKeyEnv: "",
    maxOutputTokens: 4096,
    enabled: true,
    ...overrides,
  };
}

test("provider store validates and writes version one atomically", async (t) => {
  const home = await temporary(t);
  assert.deepEqual(await readProviders(home), []);
  const saved = await saveProviders([provider({ maxOutputTokens: undefined, enabled: undefined })], home);
  assert.equal(saved[0].maxOutputTokens, 4096);
  assert.equal(saved[0].enabled, true);

  const document = JSON.parse(await fs.readFile(path.join(home, "providers.json"), "utf8"));
  assert.equal(document.version, 1);
  assert.deepEqual(await readProviders(home), saved);
  assert.deepEqual((await fs.readdir(home)).sort(), ["providers.json"]);
});

test("provider store rejects invalid and unsafe settings", async (t) => {
  const home = await temporary(t);
  const invalid = [
    provider({ id: "Uppercase" }),
    provider({ baseUrl: "http://example.com/v1" }),
    provider({ baseUrl: "https://user:pass@example.com/v1" }),
    provider({ baseUrl: "https://example.com/v1?key=value", apiKeyEnv: "REMOTE_KEY" }),
    provider({ baseUrl: "https://example.com/v1#part", apiKeyEnv: "REMOTE_KEY" }),
    provider({ apiKeyEnv: "NOT VALID" }),
    provider({ model: " " }),
    provider({ maxOutputTokens: 0 }),
    provider({ maxOutputTokens: 1_000_001 }),
    { ...provider(), apiKey: "plaintext" },
  ];
  for (const value of invalid) {
    await assert.rejects(saveProviders([value], home));
  }
  await assert.rejects(saveProviders([provider(), provider({ name: "local MODEL", id: "second" })], home), /name/i);
  await assert.rejects(saveProviders([provider(), provider({ name: "Other", id: "local_model" })], home), /id/i);
});

test("provider keys prefer the environment without storing its value", async (t) => {
  const home = await temporary(t);
  const configured = provider({ apiKeyEnv: "DIRECT_TEST_ENV" });
  const environment = { DIRECT_TEST_ENV: "environment-secret" };
  assert.equal(await getProviderKey(configured, home, environment), "environment-secret");
  assert.equal(await hasProviderKey(configured, home), false);
  await assert.rejects(fs.readFile(path.join(home, "provider-secrets.json")));
});

test("Windows stores direct provider keys as DPAPI ciphertext", { skip: !providerKeyStorageSupported }, async (t) => {
  const home = await temporary(t);
  const secret = `direct-secret-${Date.now()}`;
  await updateProviderKeys({ keys: { local_model: secret }, activeIds: ["local_model"] }, home);
  assert.equal(await hasProviderKey("local_model", home), true);
  assert.equal(await getProviderKey(provider(), home, {}), secret);
  assert.doesNotMatch(await fs.readFile(path.join(home, "provider-secrets.json"), "utf8"), new RegExp(secret));
});

test("concurrent saves leave one complete provider document", async (t) => {
  const home = await temporary(t);
  const first = saveProviders([provider({ name: "First", model: "first" })], home);
  const second = saveProviders([provider({ name: "Second", model: "second" })], home);
  await Promise.all([first, second]);
  assert.equal((await readProviders(home))[0].model, "second");
});

test("settings server authenticates API access without returning secret values", async (t) => {
  const home = await temporary(t);
  const variable = `CODEXZERO_TEST_KEY_${Date.now()}`;
  process.env[variable] = "a-secret-value";
  t.after(() => delete process.env[variable]);
  await saveProviders([provider({ apiKeyEnv: variable })], home);

  const settings = await startProviderSettings({ home });
  t.after(settings.close);
  const launched = new URL(settings.url);
  const token = launched.hash.slice(1);
  const origin = launched.origin;

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /nonce-/);
  assert.doesNotMatch(await page.text(), /a-secret-value/);

  assert.equal((await fetch(`${origin}/api/providers`)).status, 401);
  assert.equal((await fetch(`${origin}/api/providers`, {
    headers: { Authorization: `Bearer ${token}`, Origin: "https://attacker.example" },
  })).status, 403);

  const response = await fetch(`${origin}/api/providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.doesNotMatch(source, /a-secret-value/);
  const result = JSON.parse(source);
  assert.equal(result.providers[0].apiKeyEnv, variable);
  assert.equal(result.providers[0].apiKeyPresent, true);
});

test("settings server protects writes and applies validated updates", async (t) => {
  const home = await temporary(t);
  const settings = await startProviderSettings({ home });
  t.after(settings.close);
  const launched = new URL(settings.url);
  const token = launched.hash.slice(1);
  const origin = launched.origin;
  const headers = { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" };

  assert.equal((await fetch(`${origin}/api/providers`, {
    method: "PUT",
    headers: { ...headers, Origin: "https://attacker.example" },
    body: JSON.stringify({ providers: [provider()] }),
  })).status, 403);

  assert.equal((await fetch(`${origin}/api/providers`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ providers: [provider()] }),
  })).status, 403);

  const missingKey = await fetch(`${origin}/api/providers`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ providers: [provider({ baseUrl: "https://example.com/v1", apiKeyEnv: "" })] }),
  });
  assert.equal(missingKey.status, 400);

  const saved = await fetch(`${origin}/api/providers`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ providers: [provider()] }),
  });
  assert.equal(saved.status, 200);
  assert.equal((await readProviders(home))[0].id, "local_model");

  const rejected = await fetch(`${origin}/api/providers`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ providers: [{ ...provider(), apiKey: "plaintext" }] }),
  });
  assert.equal(rejected.status, 400);
  assert.doesNotMatch(await fs.readFile(path.join(home, "providers.json"), "utf8"), /plaintext/);
});
