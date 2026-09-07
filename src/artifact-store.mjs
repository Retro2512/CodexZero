import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { artifactRoot } from "./paths.mjs";

export async function storeRaw(bytes, root = artifactRoot()) {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const directory = path.join(root, "sha256");
  const destination = path.join(directory, sha256);
  await fs.mkdir(directory, { recursive: true });
  try {
    const existing = await fs.readFile(destination);
    if (!existing.equals(bytes)) {
      throw new Error(`Artifact hash collision or corruption at ${destination}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      // Publish without replacing an object another writer already committed.
      try {
        await fs.link(temporary, destination);
      } catch (publishError) {
        if (publishError.code !== "EEXIST") throw publishError;
        const existing = await fs.readFile(destination);
        if (!existing.equals(bytes)) {
          throw new Error(`Artifact hash collision or corruption at ${destination}`);
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return { sha256, rawByteCount: bytes.length, path: destination };
}
