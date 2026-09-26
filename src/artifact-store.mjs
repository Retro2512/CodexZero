import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { artifactRoot } from "./paths.mjs";
import { openArtifactForRead, prepareArtifactStore } from "./artifact-maintenance.mjs";

export async function storeRaw(bytes, root = artifactRoot()) {
  const raw = Buffer.from(bytes);
  const sha256 = crypto.createHash("sha256").update(raw).digest("hex");
  const { directory } = await prepareArtifactStore(root);
  const destination = path.join(directory, sha256);

  try {
    const existing = await openArtifactForRead(destination, { expectedBytes: raw });
    if (!existing.equals(raw)) {
      throw new Error(`Artifact hash collision or corruption at ${destination}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0);
      const handle = await fs.open(temporary, flags, 0o600);
      try {
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.writeFile(raw);
      } finally {
        await handle.close();
      }
      // Publish without replacing an object another writer already committed.
      try {
        await fs.link(temporary, destination);
      } catch (publishError) {
        if (publishError.code !== "EEXIST") throw publishError;
        const existing = await openArtifactForRead(destination, { expectedBytes: raw });
        if (!existing.equals(raw)) {
          throw new Error(`Artifact hash collision or corruption at ${destination}`);
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return { sha256, rawByteCount: raw.length, path: destination };
}
