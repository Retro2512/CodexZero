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
