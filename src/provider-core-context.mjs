import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Windows Desktop cores 0.155.0-alpha.9.2 and 0.159.2. The unknown-model constructor sets
// context_window AND max_context_window to 272000. Config overrides are then
// clamped to max_context_window even for unrelated custom API models.
//
// Release builds use exact binary pins. Background upgrades may recognize the
// same constructor only inside a PE function that references its warning and
// Rust source marker, then must pass the independent offline compatibility suite.
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
export const PROVIDER_CONTEXT_PATCHES = Object.freeze([
  PROVIDER_CONTEXT_PATCH,
  Object.freeze({
    sourceSha256: "cbafb6422bca005b94c12d105b1a16a0474219e24ea4893f85846409c464f5a1",
    offset: 0xa58ac72, before: 272000, after: 10000000,
  }),
]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function contextPatch(source, { allowCompatible = false } = {}) {
  const digest = hash(source);
  const patch = PROVIDER_CONTEXT_PATCHES.find(patch => patch.sourceSha256 === digest);
  if (patch) return patch;
  if (allowCompatible) {
    const offset = compatibleContextOffset(source);
    if (offset !== null) return { sourceSha256: digest, offset, before: 272000, after: 10000000, recipe: 1 };
  }
  throw new Error("This Codex version needs an updated custom context patch");
}

// Never scan for a bare integer. These instructions encode two Option<i64>
// fields: default context 272000, maximum 272000, then a None compact limit.
const constructor = Buffer.from("48c7060100000048c746088026040048c746100100000048c746188026040048c7462000000000", "hex");
export function compatibleContextOffset(bytes) {
  try {
    if (bytes.length < 256 || bytes.toString("ascii", 0, 2) !== "MZ") return null;
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString("ascii", pe, pe + 4) !== "PE\0\0" || bytes.readUInt16LE(pe + 4) !== 0x8664) return null;
    const count = bytes.readUInt16LE(pe + 6), optional = pe + 24;
    if (count > 96 || bytes.readUInt16LE(optional) !== 0x20b || bytes.readUInt32LE(optional + 108) < 4) return null;
    const sections = [];
    for (let i = 0, start = optional + bytes.readUInt16LE(pe + 20); i < count; i++) {
      const at = start + i * 40;
      sections.push({ rva: bytes.readUInt32LE(at + 12), size: bytes.readUInt32LE(at + 16),
        raw: bytes.readUInt32LE(at + 20), executable: !!(bytes.readUInt32LE(at + 36) & 0x20000000),
        readable: !!(bytes.readUInt32LE(at + 36) & 0x40000000), writable: !!(bytes.readUInt32LE(at + 36) & 0x80000000) });
    }
    const fileOffset = rva => {
      const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
      if (!section) throw new Error("Unmapped RVA");
      const at = section.raw + rva - section.rva;
      if (at < 0 || at >= bytes.length) throw new Error("Invalid RVA");
      return at;
    };
    const start = bytes.indexOf(constructor);
    if (start < 0 || bytes.indexOf(constructor, start + 1) !== -1) return null;
    const offset = start + 27;
    const code = sections.find(s => s.executable && start >= s.raw && offset + 34 < s.raw + s.size);
    if (!code) return null;
    // mov [rsi+disp32], rbx; mov qword [rsi+disp32],95. Preserve the reserve.
    if (bytes.subarray(offset + 12, offset + 15).toString("hex") !== "48899e" ||
        bytes.subarray(offset + 19, offset + 22).toString("hex") !== "48c786" || bytes.readUInt32LE(offset + 26) !== 95) return null;
    const exceptionRva = bytes.readUInt32LE(optional + 112 + 3 * 8);
    const exceptionSize = bytes.readUInt32LE(optional + 116 + 3 * 8);
    if (!exceptionRva || exceptionSize % 12 || exceptionSize > 16 * 1024 * 1024) return null;
    const table = fileOffset(exceptionRva), targetRva = code.rva + start - code.raw;
    const dataSection = at => sections.find(s => !s.executable && s.readable && !s.writable && at >= s.raw && at < s.raw + s.size);
    const exceptionSection = dataSection(table);
    if (!exceptionSection || table + exceptionSize > Math.min(bytes.length, exceptionSection.raw + exceptionSection.size)) return null;
    for (let i = table; i < table + exceptionSize; i += 12) {
      const begin = bytes.readUInt32LE(i), end = bytes.readUInt32LE(i + 4);
      if (targetRva < begin || targetRva >= end || end - begin > 16384) continue;
      const first = fileOffset(begin), last = fileOffset(end - 1) + 1;
      if (first > start || last < offset + 30) return null;
      for (let at = first; at + 7 <= last; at++) {
        if (![0x48, 0x4c].includes(bytes[at]) || bytes[at + 1] !== 0x8d || (bytes[at + 2] & 0xc7) !== 0x05) continue;
        const rva = begin + at - first + 7 + bytes.readInt32LE(at + 3);
        let textOffset;
        try { textOffset = fileOffset(rva); } catch { continue; }
        const section = dataSection(textOffset);
        if (!section) continue;
        const marker = bytes.subarray(textOffset, Math.min(textOffset + 192, section.raw + section.size, bytes.length)).toString("utf8");
        if (marker.includes("Unknown model") && marker.includes("fallback model metadata") &&
            /models-manager[\\/]src[\\/]model_info\.rs/.test(marker)) return offset;
      }
    }
  } catch { /* Malformed or changed PE layout must never be patched. */ }
  return null;
}

export function patchProviderContextBytes(source, options = {}) {
  const patch = contextPatch(source, options);
  const anchor = Buffer.from("48c746100100000048c746188026040048c7462000000000", "hex");
  if (!source.subarray(patch.offset - 12, patch.offset - 12 + anchor.length).equals(anchor)) {
    throw new Error("The custom context patch does not match this core");
  }
  const patched = Buffer.from(source);
  patched.writeUInt32LE(patch.after, patch.offset);
  return patched;
}

export async function prepareProviderContextCore(source, options = {}) {
  const bytes = await fs.readFile(source);
  const patched = patchProviderContextBytes(bytes, options);
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
    ...contextPatch(bytes, options), patchedSha256: hash(patched), source: path.basename(source)
  }, null, 2));
  return destination;
}
