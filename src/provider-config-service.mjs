import { readProviders, saveProviders, validateProviders } from "./provider-store.mjs";
import { hasProviderKey, providerKeyStorageSupported, updateProviderKeys } from "./provider-secrets.mjs";
import { codexZeroHome } from "./paths.mjs";

const writes = new Map();

export async function readProviderSettings(home = codexZeroHome(), environment = process.env) {
  const providers = await readProviders(home);
  return {
    providers: await Promise.all(providers.map(async provider => ({
      ...provider,
      apiKeyPresent: Boolean(provider.apiKeyEnv && environment[provider.apiKeyEnv]),
      directKeyPresent: await hasProviderKey(provider, home)
    }))),
    directKeySupported: providerKeyStorageSupported
  };
}

export function saveProviderSettings(document, home = codexZeroHome()) {
  const previous = writes.get(home) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (!document || typeof document !== "object" || Array.isArray(document) ||
        Object.keys(document).some(key => !["providers", "keys", "clearKeys"].includes(key))) {
      throw new TypeError("Invalid provider settings");
    }
    const providers = validateProviders(document.providers);
    const keys = document.keys ?? {};
    const clear = document.clearKeys ?? [];
    if (typeof keys !== "object" || Array.isArray(keys) || !Array.isArray(clear)) throw new TypeError("Invalid API keys");
    const ids = providers.map(p => p.id);
    const previousIds = (await readProviders(home)).map(provider => provider.id);
    if (Object.keys(keys).some(id => !ids.includes(id)) || clear.some(id => !ids.includes(id) && !previousIds.includes(id))) throw new TypeError("Invalid API key provider");
    for (const key of Object.values(keys)) {
      if (typeof key !== "string" || !key || key.length > 16384) throw new TypeError("Invalid API key");
    }
    for (const provider of providers) {
      const host = new URL(provider.baseUrl).hostname;
      const local = host === "localhost" || host === "[::1]" || /^127\./.test(host);
      const direct = providerKeyStorageSupported && (Object.hasOwn(keys, provider.id) || (!clear.includes(provider.id) && await hasProviderKey(provider, home)));
      if (provider.enabled && !local && !provider.apiKeyEnv && !direct) throw new TypeError("Enter an API key or environment variable");
    }
    await updateProviderKeys({ keys, clear, activeIds: ids }, home);
    await saveProviders(providers, home);
    return readProviderSettings(home);
  });
  writes.set(home, current);
  current.finally(() => { if (writes.get(home) === current) writes.delete(home); }).catch(() => {});
  return current;
}
