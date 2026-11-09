import fs from "node:fs/promises";
import path from "node:path";

// Applies to scripts/browser-service.mjs in the Browser Use package.
export const BROWSER_DISCOVERY_TARGET = "candidatePipeCount";
const originalDiscovery = "l=await Promise.all(s.map(b=>Qce(e,b,a.get(b),t,n))),u=new Set(s);";
const serialDiscovery = "l=[];for(let b of s)l.push(await Qce(e,b,a.get(b),t,n));let u=new Set(s);";

export function patchBrowserDiscovery(source) {
  if (source.includes(serialDiscovery) && !source.includes(originalDiscovery)) return source;
  if (source.split(originalDiscovery).length !== 2 || !source.includes(BROWSER_DISCOVERY_TARGET)) {
    throw new Error("This Codex version needs an updated Browser Use discovery patch");
  }
  return source.replace(originalDiscovery, serialDiscovery);
}

export async function patchCopiedBrowserService(appRoot) {
  const servicePath = path.join(appRoot, "resources", "cua_node", "bin", "node_modules", "@oai", "browser-desktop", "scripts", "browser-service.mjs");
  const original = await fs.readFile(servicePath, "utf8");
  const patched = patchBrowserDiscovery(original);
  if (patched !== original) await fs.writeFile(servicePath, patched);
  return servicePath;
}
