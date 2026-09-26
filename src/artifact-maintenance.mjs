import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { artifactRoot } from "./paths.mjs";

const HASH_FILE = /^[0-9a-f]{64}$/u;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_WINDOWS = process.platform === "win32";

function resolvedRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("Artifact root must be a nonempty path");
  }
  return path.resolve(root);
}

function openFlags(directory = false, writable = false) {
  return (writable ? constants.O_RDWR : constants.O_RDONLY) |
    (directory ? (constants.O_DIRECTORY ?? 0) : 0) |
    (constants.O_NOFOLLOW ?? 0);
}

function ownedByCurrentUser(stats) {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertDirectory(stats, file) {
  if (stats.isSymbolicLink()) {
    const error = new Error(`Artifact path must not be a symbolic link: ${file}`);
    error.code = "ELOOP";
    throw error;
  }
  if (!stats.isDirectory()) {
    const error = new Error(`Artifact path is not a directory: ${file}`);
    error.code = "ENOTDIR";
    throw error;
  }
}

async function enforcePrivateDirectory(directory, { create = false } = {}) {
  let stats = await lstatOrNull(directory);
  if (!stats && create) {
    await fs.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    stats = await fs.lstat(directory);
  }
  if (!stats) return { exists: false, changed: false };
  assertDirectory(stats, directory);

  if (IS_WINDOWS) {
    return { exists: true, changed: false };
  }

  const handle = await fs.open(directory, openFlags(true));
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameFile(stats, opened)) {
      throw new Error(`Artifact directory changed while opening: ${directory}`);
    }
    if (!ownedByCurrentUser(opened)) {
      const error = new Error(`Artifact directory is not owned by the current user: ${directory}`);
      error.code = "EOWNER";
      throw error;
    }
    const changed = !IS_WINDOWS && (opened.mode & 0o777) !== DIRECTORY_MODE;
    if (changed) await handle.chmod(DIRECTORY_MODE);
    return { exists: true, changed };
  } finally {
    await handle.close();
  }
}

export async function prepareArtifactStore(root = artifactRoot()) {
  const resolved = resolvedRoot(root);
  await enforcePrivateDirectory(resolved, { create: true });
  const directory = path.join(resolved, "sha256");
  await enforcePrivateDirectory(directory, { create: true });
  return { root: resolved, directory };
}

export async function openArtifactForRead(file, { expectedBytes } = {}) {
  const before = await fs.lstat(file);
  if (before.isSymbolicLink()) {
    const error = new Error(`Artifact object must not be a symbolic link: ${file}`);
    error.code = "ELOOP";
    throw error;
  }
  if (!before.isFile()) {
    const error = new Error(`Artifact object is not a regular file: ${file}`);
    error.code = "EINVAL";
    throw error;
  }

  const handle = await fs.open(file, openFlags(false, IS_WINDOWS));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error(`Artifact object changed while opening: ${file}`);
    }
    if (!ownedByCurrentUser(opened)) {
      const error = new Error(`Artifact object is not owned by the current user: ${file}`);
      error.code = "EOWNER";
      throw error;
    }
    if (!IS_WINDOWS && (opened.mode & 0o777) !== FILE_MODE) {
      await handle.chmod(FILE_MODE);
    }
    const bytes = await handle.readFile();
    if (expectedBytes && bytes.equals(expectedBytes)) {
      const accessedAt = new Date();
      await handle.utimes(accessedAt, accessedAt);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function pruneArtifacts({
  root = artifactRoot(),
  olderThanDays = 30,
  dryRun = false,
  now = Date.now()
} = {}) {
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new TypeError("olderThanDays must be a finite positive number");
  }
  if (!Number.isFinite(now) || now <= 0) {
    throw new TypeError("now must be a finite positive timestamp");
  }
  if (typeof dryRun !== "boolean") {
    throw new TypeError("dryRun must be a boolean");
  }
  const cutoff = now - olderThanDays * DAY_MS;
  if (!Number.isFinite(cutoff)) {
    throw new TypeError("olderThanDays produces an invalid cutoff");
  }
  const resolved = resolvedRoot(root);
  const result = {
    scanned: 0,
    eligible: 0,
    removed: 0,
    candidateBytes: 0,
    bytesRemoved: 0,
    skipped: 0,
    dryRun
  };
  const rootStats = await lstatOrNull(resolved);
  if (!rootStats) return result;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    result.skipped += 1;
    return result;
  }
  if (!ownedByCurrentUser(rootStats)) {
    result.skipped += 1;
    return result;
  }
  const directory = path.join(resolved, "sha256");
  const directoryStats = await lstatOrNull(directory);
  if (!directoryStats) return result;
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    result.skipped += 1;
    return result;
  }
  if (!ownedByCurrentUser(directoryStats)) {
    result.skipped += 1;
    return result;
  }

  for (const name of await fs.readdir(directory)) {
    if (!HASH_FILE.test(name)) {
      result.skipped += 1;
      continue;
    }
    result.scanned += 1;
    const file = path.join(directory, name);
    const before = await lstatOrNull(file);
    if (!before || before.isSymbolicLink() || !before.isFile() || !ownedByCurrentUser(before)) {
      result.skipped += 1;
      continue;
    }
    if (before.mtimeMs > cutoff) continue;

    result.eligible += 1;
    result.candidateBytes += before.size;
    if (dryRun) continue;

    // Recheck age and identity immediately before unlinking so a path replaced
    // or refreshed after the scan is not treated as stale.
    const current = await lstatOrNull(file);
    if (!current || current.isSymbolicLink() || !current.isFile() ||
        !ownedByCurrentUser(current) || !sameFile(before, current) ||
        current.mtimeMs > cutoff) {
      result.eligible -= 1;
      result.candidateBytes -= before.size;
      result.skipped += 1;
      continue;
    }
    await fs.unlink(file);
    result.removed += 1;
    result.bytesRemoved += current.size;
  }
  return result;
}

export async function repairArtifacts({ root = artifactRoot() } = {}) {
  const resolved = resolvedRoot(root);
  const result = { directoriesRepaired: 0, filesRepaired: 0, skipped: 0 };
  const rootStats = await lstatOrNull(resolved);
  if (!rootStats) return result;
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Artifact root must not be a symbolic link: ${resolved}`);
  }
  assertDirectory(rootStats, resolved);

  let rootRepair;
  try {
    rootRepair = await enforcePrivateDirectory(resolved);
  } catch (error) {
    if (error.code === "EOWNER") {
      result.skipped += 1;
      return result;
    }
    throw error;
  }
  if (rootRepair.changed) result.directoriesRepaired += 1;

  const directory = path.join(resolved, "sha256");
  const directoryStats = await lstatOrNull(directory);
  if (!directoryStats) return result;
  if (directoryStats.isSymbolicLink()) {
    result.skipped += 1;
    return result;
  }
  assertDirectory(directoryStats, directory);

  let storeRepair;
  try {
    storeRepair = await enforcePrivateDirectory(directory);
  } catch (error) {
    if (error.code === "EOWNER") {
      result.skipped += 1;
      return result;
    }
    throw error;
  }
  if (storeRepair.changed) result.directoriesRepaired += 1;

  for (const name of await fs.readdir(directory)) {
    if (!HASH_FILE.test(name)) {
      result.skipped += 1;
      continue;
    }
    const file = path.join(directory, name);
    const before = await lstatOrNull(file);
    if (!before || before.isSymbolicLink() || !before.isFile() || !ownedByCurrentUser(before)) {
      result.skipped += 1;
      continue;
    }
    const handle = await fs.open(file, openFlags());
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened) || !ownedByCurrentUser(opened)) {
        result.skipped += 1;
        continue;
      }
      if (!IS_WINDOWS && (opened.mode & 0o777) !== FILE_MODE) {
        await handle.chmod(FILE_MODE);
        result.filesRepaired += 1;
      }
    } finally {
      await handle.close();
    }
  }
  return result;
}
