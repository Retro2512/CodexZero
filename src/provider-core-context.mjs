import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Windows Desktop core 0.155.0-alpha.9.2. Its unknown-model constructor sets
// context_window AND max_context_window to 272000. Config overrides are then
// clamped to max_context_window even for unrelated custom API models.
//
// This is a version-pinned compatibility patch, not a pattern replacement.
// Disassembly identifies model_info_from_slug via its "Unknown model" warning
// and models-manager/src/model_info.rs source marker. At file offset 0x9e2a0da:
//   mov qword ptr [rsi + 0x18], 272000  ; max_context_window.value
// The earlier [rsi + 8] default context and later 95% reserve stay unchanged.
// Known model metadata, model discovery, authentication, permissions, and the
// installed Codex executable are untouched. Only an explicit context override
// can use the raised ceiling, bounded by provider-store's 10000000 maximum.
export const PROVIDER_CONTEXT_PATCH = Object.freeze({
  sourceSha256: "bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226",
  offset: 0x9e2a0de,
  before: 272000,
  after: 10000000,
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function patchProviderContextBytes(source) {
  const patch = PROVIDER_CONTEXT_PATCH;
  if (hash(source) !== patch.sourceSha256) throw new Error("This Codex version needs an updated custom context patch");
  const anchor = Buffer.from("48c746100100000048c746188026040048c7462000000000", "hex");
  if (!source.subarray(patch.offset - 12, patch.offset - 12 + anchor.length).equals(anchor)) {
    throw new Error("The custom context patch does not match this core");
  }
  const patched = Buffer.from(source);
  patched.writeUInt32LE(patch.after, patch.offset);
  return patched;
}

export async function prepareProviderContextCore(source) {
  const bytes = await fs.readFile(source);
  const patched = patchProviderContextBytes(bytes);
  const destination = path.join(path.dirname(source), "codex-provider-context.exe");
  // Never patch in place, and never overwrite an unrecognized existing binary.
  try {
    const existing = await fs.readFile(destination);
    if (!existing.equals(patched)) throw new Error("The custom context runtime needs rebuilding");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(destination, patched, { flag: "wx" });
  }
  await fs.writeFile(`${destination}.json`, JSON.stringify({
    ...PROVIDER_CONTEXT_PATCH, patchedSha256: hash(patched), source: path.basename(source)
  }, null, 2));
  return destination;
}
