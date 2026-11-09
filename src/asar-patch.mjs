import fs from "node:fs/promises";
import { createHash } from "node:crypto";

export async function openAsar(file) {
  const handle = await fs.open(file, "r");
  const prefix = Buffer.alloc(16);
  await handle.read(prefix, 0, 16, 0);
  const length = prefix.readUInt32LE(12);
  if (length > 32 * 1024 * 1024 || prefix.readUInt32LE(0) !== 4) { await handle.close(); throw new Error("Unsupported app archive"); }
  const bytes = Buffer.alloc(length);
  await handle.read(bytes, 0, length, 16);
  const header = JSON.parse(bytes.toString("utf8"));
  const dataOffset = 8 + prefix.readUInt32LE(4);
  function entry(name) {
    return name.split("/").reduce((node, key) => node?.files?.[key], header);
  }
  return { header, handle, dataOffset, entry,
    async read(name) {
      const item = entry(name);
      if (!item || item.unpacked || item.link || item.files) throw new Error(`Missing packed app asset: ${name}`);
      const data = Buffer.alloc(item.size);
      await handle.read(data, 0, data.length, dataOffset + Number(item.offset));
      return data;
    },
    close: () => handle.close()
  };
}

// The desktop is built from thousands of content-hashed chunks, so patches
// name the code they change by a literal that occurs in exactly one script.
export async function locateTargets(archive, markers, roots = [".vite/build", "webview/assets"]) {
  const wanted = [...new Set(markers)];
  const found = new Map(wanted.map(marker => [marker, []]));
  const scripts = [];
  for (const root of roots) {
    const node = archive.entry(root);
    if (!node) throw new Error(`Missing app folder: ${root}`);
    (function walk(entry, prefix) {
      for (const [key, value] of Object.entries(entry.files ?? {})) {
        const name = `${prefix}/${key}`;
        if (value.files) walk(value, name);
        else if (!value.unpacked && !value.link && /\.(c?js|mjs)$/.test(key)) scripts.push(name);
      }
    })(node, root);
  }
  for (const name of scripts) {
    const text = (await archive.read(name)).toString("latin1");
    for (const marker of wanted) if (text.includes(marker)) found.get(marker).push(name);
  }
  const result = new Map();
  for (const [marker, names] of found) {
    if (names.length !== 1) throw new Error(`This Codex version needs an updated patch target (${names.length} files contain ${JSON.stringify(marker.slice(0, 60))})`);
    result.set(marker, names[0]);
  }
  return result;
}

export async function asarHeaderHash(file) {
  const handle = await fs.open(file, "r");
  try {
    const prefix = Buffer.alloc(16);
    await handle.read(prefix, 0, 16, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(12));
    await handle.read(header, 0, header.length, 16);
    return createHash("sha256").update(header).digest("hex");
  } finally { await handle.close(); }
}

// Windows builds embed the archive header hash in the executable and refuse to
// start when it differs. The copied executable gets the patched archive's hash.
export async function updateEmbeddedAsarIntegrity(executable, originalArchive, patchedArchive) {
  const [before, after] = [await asarHeaderHash(originalArchive), await asarHeaderHash(patchedArchive)];
  const bytes = await fs.readFile(executable);
  const marker = Buffer.from(`"value":"${before}"`);
  const first = bytes.indexOf(marker);
  if (first < 0) return false;
  if (bytes.indexOf(marker, first + 1) >= 0) throw new Error("The desktop executable has more than one archive integrity record");
  Buffer.from(`"value":"${after}"`).copy(bytes, first);
  await fs.writeFile(executable, bytes);
  return true;
}

function integrity(bytes) {
  const blockSize = 4 * 1024 * 1024;
  const hash = value => createHash("sha256").update(value).digest("hex");
  const blocks = [];
  for (let i = 0; i < bytes.length; i += blockSize) blocks.push(hash(bytes.subarray(i, i + blockSize)));
  return { algorithm: "SHA256", hash: hash(bytes), blockSize, blocks };
}

export async function rewriteAsar(source, destination, replacements) {
  if (source === destination) throw new Error("The original app archive must be preserved");
  const archive = await openAsar(source);
  const header = structuredClone(archive.header);
  const items = [];
  try {
    for (const name of replacements.keys()) {
      const keys = name.split("/");
      if (keys.some(key => !key || key === ".." || key === ".")) throw new Error("Invalid app asset path");
      let node = header;
      for (const key of keys.slice(0, -1)) {
        node.files ??= {};
        node.files[key] ??= { files: {} };
        node = node.files[key];
      }
      node.files ??= {};
      node.files[keys.at(-1)] = { size: 0, offset: "0" };
    }
    let offset = 0;
    function visit(node, prefix = "") {
      for (const [key, value] of Object.entries(node.files ?? {})) {
        const name = prefix ? `${prefix}/${key}` : key;
        if (value.files) { visit(value, name); continue; }
        if (value.unpacked || value.link) continue;
        const replacement = replacements.get(name);
        const original = archive.entry(name);
        if (replacement) { value.size = replacement.length; value.integrity = integrity(replacement); }
        value.offset = String(offset);
        items.push({ name, value, replacement, original });
        offset += value.size;
      }
    }
    visit(header);
    const json = Buffer.from(JSON.stringify(header));
    const padding = (4 - json.length % 4) % 4;
    const headerSize = 8 + json.length + padding;
    const pickle = Buffer.alloc(8 + headerSize);
    pickle.writeUInt32LE(4, 0);
    pickle.writeUInt32LE(headerSize, 4);
    pickle.writeUInt32LE(headerSize - 4, 8);
    pickle.writeUInt32LE(json.length, 12);
    json.copy(pickle, 16);
    const output = await fs.open(destination, "wx");
    try {
      await output.write(pickle);
      const buffer = Buffer.alloc(4 * 1024 * 1024);
      for (const item of items) {
        if (item.replacement) { await output.write(item.replacement); continue; }
        for (let position = 0; position < item.value.size;) {
          const length = Math.min(buffer.length, item.value.size - position);
          const result = await archive.handle.read(buffer, 0, length, archive.dataOffset + Number(item.original.offset) + position);
          if (result.bytesRead !== length) throw new Error("The app archive is incomplete");
          await output.write(buffer, 0, length);
          position += length;
        }
      }
      await output.sync();
    } finally { await output.close(); }
  } finally { await archive.close(); }
}
