import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pruneArtifacts, repairArtifacts } from "../src/artifact-maintenance.mjs";
import { storeRaw } from "../src/artifact-store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const onUnix = process.platform !== "win32";

async function artifactRoot(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-artifact-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return path.join(temporary, "artifacts");
}

async function modeOf(file) {
  return (await fs.stat(file)).mode & 0o777;
}

async function trySymlink(t, target, link, type = "file") {
  try {
    await fs.symlink(target, link, type);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) {
      t.skip(`symlink creation is unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

test("stores raw bytes exactly by SHA 256", async (t) => {
  const root = await artifactRoot(t);
  const raw = Buffer.from([0, 255, 13, 10, 27, 91, 51, 49, 109]);
  const artifact = await storeRaw(raw, root);
  assert.deepEqual(await fs.readFile(artifact.path), raw);
  assert.equal(artifact.rawByteCount, raw.length);
  assert.equal(artifact.sha256, crypto.createHash("sha256").update(raw).digest("hex"));
});

test("concurrent identical writes publish one verified object without temporary residue", async (t) => {
  const root = await artifactRoot(t);
  const raw = Buffer.alloc(64 * 1024, 42);
  const results = await Promise.all(Array.from({ length: 32 }, () => storeRaw(raw, root)));
  assert.ok(results.every((result) => result.path === results[0].path));
  assert.deepEqual(await fs.readFile(results[0].path), raw);
  assert.deepEqual(await fs.readdir(path.join(root, "sha256")), [results[0].sha256]);
});

test("a corrupt existing artifact is never replaced", async (t) => {
  const root = await artifactRoot(t);
  const raw = Buffer.from("original");
  const result = await storeRaw(raw, root);
  await fs.writeFile(result.path, "corrupt");
  await assert.rejects(storeRaw(raw, root), /corruption/);
  assert.equal(await fs.readFile(result.path, "utf8"), "corrupt");
});

test("reusing an old object refreshes its retention age", async (t) => {
  const root = await artifactRoot(t);
  const raw = Buffer.from("active output");
  const artifact = await storeRaw(raw, root);
  const oldDate = new Date(Date.now() - 31 * DAY_MS);
  await fs.utimes(artifact.path, oldDate, oldDate);

  await storeRaw(raw, root);
  const now = Date.now();
  const result = await pruneArtifacts({ root, olderThanDays: 30, now });
  assert.equal(result.eligible, 0);
  assert.equal(result.removed, 0);
  assert.deepEqual(await fs.readFile(artifact.path), raw);
  assert.ok((await fs.stat(artifact.path)).mtimeMs > now - 30 * DAY_MS);
});

test("artifact directories and objects use private Unix permissions", async (t) => {
  if (!onUnix) {
    t.skip("Unix permission bits are not available on Windows");
    return;
  }
  const root = await artifactRoot(t);
  const artifact = await storeRaw(Buffer.from("private"), root);
  assert.equal(await modeOf(root), 0o700);
  assert.equal(await modeOf(path.join(root, "sha256")), 0o700);
  assert.equal(await modeOf(artifact.path), 0o600);
});

test("store rejects a symbolic link as the artifact root", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-artifact-link-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, "target");
  const link = path.join(parent, "linked-artifacts");
  await fs.mkdir(target);
  if (!(await trySymlink(t, target, link, "dir"))) return;
  await assert.rejects(storeRaw(Buffer.from("no follow"), link), /symbolic link/);
  assert.deepEqual(await fs.readdir(target), []);
});

test("repair restores modes only for known owned artifact paths", async (t) => {
  if (!onUnix) {
    t.skip("Unix permission bits are not available on Windows");
    return;
  }
  const root = await artifactRoot(t);
  const artifact = await storeRaw(Buffer.from("repair me"), root);
  const storeDirectory = path.join(root, "sha256");
  await fs.chmod(root, 0o755);
  await fs.chmod(storeDirectory, 0o755);
  await fs.chmod(artifact.path, 0o644);
  await fs.writeFile(path.join(storeDirectory, "unknown.tmp"), "leave as is", { mode: 0o644 });
  const unknown = path.join(storeDirectory, "unknown.tmp");

  const result = await repairArtifacts({ root });
  assert.equal(result.directoriesRepaired, 2);
  assert.equal(result.filesRepaired, 1);
  assert.equal(result.skipped, 1);
  assert.equal(await modeOf(root), 0o700);
  assert.equal(await modeOf(storeDirectory), 0o700);
  assert.equal(await modeOf(artifact.path), 0o600);
  assert.equal(await modeOf(unknown), 0o644);
});

test("repair skips symlink objects", async (t) => {
  if (!onUnix) {
    t.skip("Unix permission bits are not available on Windows");
    return;
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-artifact-repair-link-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "artifacts");
  const storeDirectory = path.join(root, "sha256");
  const outside = path.join(parent, "outside");
  await fs.mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  await fs.writeFile(outside, "outside", { mode: 0o644 });
  const name = crypto.createHash("sha256").update("link").digest("hex");
  if (!(await trySymlink(t, outside, path.join(storeDirectory, name)))) return;

  const result = await repairArtifacts({ root });
  assert.equal(result.skipped, 1);
  assert.equal(await modeOf(outside), 0o644);
});

test("repair leaves a missing artifact root alone", async (t) => {
  const root = await artifactRoot(t);
  const result = await repairArtifacts({ root });
  assert.deepEqual(result, { directoriesRepaired: 0, filesRepaired: 0, skipped: 0 });
  await assert.rejects(fs.lstat(root), { code: "ENOENT" });
});

test("dry run reports old candidates without changing any files or modes", async (t) => {
  const root = await artifactRoot(t);
  const old = await storeRaw(Buffer.from("old output"), root);
  const recent = await storeRaw(Buffer.from("recent output"), root);
  const directory = path.join(root, "sha256");
  const now = Date.now();
  const oldDate = new Date(now - 31 * DAY_MS);
  await fs.utimes(old.path, oldDate, oldDate);
  let beforeModes;
  if (onUnix) {
    await fs.chmod(root, 0o755);
    await fs.chmod(directory, 0o755);
    await fs.chmod(old.path, 0o644);
    beforeModes = [await modeOf(root), await modeOf(directory), await modeOf(old.path)];
  }

  const result = await pruneArtifacts({ root, olderThanDays: 30, dryRun: true, now });
  assert.equal(result.scanned, 2);
  assert.equal(result.eligible, 1);
  assert.equal(result.removed, 0);
  assert.equal(result.candidateBytes, Buffer.byteLength("old output"));
  assert.equal(result.bytesRemoved, 0);
  assert.equal(result.dryRun, true);
  assert.deepEqual(await fs.readFile(old.path), Buffer.from("old output"));
  assert.deepEqual(await fs.readFile(recent.path), Buffer.from("recent output"));
  if (beforeModes) {
    assert.deepEqual([await modeOf(root), await modeOf(directory), await modeOf(old.path)], beforeModes);
  }
});

test("prune validates age and timestamp options before touching the store", async (t) => {
  const root = await artifactRoot(t);
  for (const olderThanDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(pruneArtifacts({ root, olderThanDays }), /olderThanDays/);
  }
  for (const now of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(pruneArtifacts({ root, now }), /now/);
  }
  assert.equal(await fs.stat(root).then(() => true, () => false), false);
});

test("prune skips roots and store directories owned by another user", async (t) => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("changing ownership requires a Unix root test process");
    return;
  }
  const root = await artifactRoot(t);
  await storeRaw(Buffer.from("owned elsewhere"), root);
  const storeDirectory = path.join(root, "sha256");
  try {
    await fs.chown(root, 65534, 65534);
  } catch (error) {
    if (["EPERM", "EACCES", "EINVAL", "ENOSYS"].includes(error.code)) {
      t.skip(`ownership changes are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  let result = await pruneArtifacts({ root });
  assert.equal(result.skipped, 1);
  assert.equal(result.scanned, 0);

  const secondRoot = await artifactRoot(t);
  const artifact = await storeRaw(Buffer.from("unowned store"), secondRoot);
  const secondStore = path.join(secondRoot, "sha256");
  await fs.chown(secondStore, 65534, 65534);
  result = await pruneArtifacts({ root: secondRoot });
  assert.equal(result.skipped, 1);
  assert.equal(result.scanned, 0);
  assert.deepEqual(await fs.readFile(artifact.path), Buffer.from("unowned store"));
});

test("prune removes only old hash objects and ignores symlinks and unknown entries", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-artifact-prune-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "artifacts");
  const old = await storeRaw(Buffer.from("old bytes"), root);
  const recent = await storeRaw(Buffer.from("recent bytes"), root);
  const outside = path.join(parent, "outside");
  const unknown = path.join(root, "sha256", "notes.txt");
  await fs.writeFile(outside, "keep outside");
  await fs.writeFile(unknown, "keep unknown");
  const link = path.join(root, "sha256", crypto.createHash("sha256").update("link").digest("hex"));
  const canLink = await trySymlink(t, outside, link);
  const now = Date.now();
  const oldDate = new Date(now - 31 * DAY_MS);
  await fs.utimes(old.path, oldDate, oldDate);

  const dry = await pruneArtifacts({ root, olderThanDays: 30, dryRun: true, now });
  assert.equal(dry.eligible, 1);
  assert.equal(dry.skipped, canLink ? 2 : 1);
  assert.equal(await fs.readFile(old.path, "utf8"), "old bytes");

  const result = await pruneArtifacts({ root, olderThanDays: 30, now });
  assert.equal(result.eligible, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.bytesRemoved, Buffer.byteLength("old bytes"));
  assert.equal(await fs.stat(old.path).then(() => true, () => false), false);
  assert.equal(await fs.readFile(recent.path, "utf8"), "recent bytes");
  assert.equal(await fs.readFile(unknown, "utf8"), "keep unknown");
  assert.equal(await fs.readFile(outside, "utf8"), "keep outside");
  if (canLink) assert.ok((await fs.lstat(link)).isSymbolicLink());
});
