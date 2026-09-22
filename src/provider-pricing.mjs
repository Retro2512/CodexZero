import { readProviders } from "./provider-store.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { codexZeroHome } from "./paths.mjs";

// Earlier adapters discarded cache usage. Keep those historical estimates partial.
export async function recordProviderUsageVersion(home = codexZeroHome()) {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "provider-usage-version.json"), JSON.stringify({ version: 2, since: Date.now() }),
    { flag: "wx", mode: 0o600 }).catch(error => { if (error.code !== "EEXIST") throw error; });
}

// Scope prices to the exact configured picker entry, never infer them from a model family.
export async function readProviderPricing(home = codexZeroHome()) {
  const version = await fs.readFile(path.join(home, "provider-usage-version.json"), "utf8").then(JSON.parse)
    .catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const prices = {};
  for (const provider of await readProviders(home)) {
    if (provider.pricing) prices[`custom/${provider.id}`] = {
      ...provider.pricing, write: provider.pricing.write ?? provider.pricing.input,
      label: provider.pricing.label ?? "API estimate",
      ...(version?.version === 2 && Number.isSafeInteger(version.since) ? { cacheUsageSince: version.since } : {})
    };
  }
  return prices;
}
