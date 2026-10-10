import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const CORE_BINDING_NAME = "codex-custom-models.core.json";

// Installation metadata, not discovery: only the core selected by the builder
// can be used. Relative paths survive installing or moving the whole package.
export async function writeProviderCoreBinding(directory, core) {
  const binding = path.join(directory, CORE_BINDING_NAME);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${binding}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, core: path.relative(directory, path.resolve(core)) }), { flag: "wx" });
    await fs.rename(temporary, binding);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return binding;
}

export async function resolveProviderCore({ environment = process.env, installationRoot } = {}) {
  if (environment.CODEX_ZERO_PROVIDER_CORE) return environment.CODEX_ZERO_PROVIDER_CORE;
  const binding = environment.CODEX_ZERO_CORE_BINDING || path.join(installationRoot, "provider-runtime", CORE_BINDING_NAME);
  let data;
  try {
    if ((await fs.stat(binding)).size > 32_768) throw new Error("Binding is too large");
    data = JSON.parse(await fs.readFile(binding, "utf8"));
  } catch (error) {
    throw new Error("Installed Codex core binding is missing or unreadable", { cause: error });
  }
  if (data?.schema !== 1 || typeof data.core !== "string" || !data.core || data.core.includes("\0") || path.isAbsolute(data.core)) {
    throw new Error("Installed Codex core binding is invalid");
  }
  const core = path.resolve(path.dirname(binding), data.core);
  if (!(await fs.stat(core)).isFile()) throw new Error("Installed Codex core is not a file");
  return core;
}
