"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Each platform updates from its own release package.
const ARCHIVES = Object.freeze({
  "win32-x64": "codex-zero-windows-x64.zip",
  "darwin-arm64": "codex-zero-macos-arm64.tar.gz",
  "darwin-x64": "codex-zero-macos-x64.tar.gz",
});
const RELEASE_ROOT = "https://github.com/Retro2512/CodexZero/releases/download";
const MAX_CHECKSUM_BYTES = 8 * 1024;
const MAX_ARCHIVE_BYTES = 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const STABLE_VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    version: value.startsWith("v") ? value.slice(1) : value,
  };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new TypeError("Expected stable semantic versions");
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  return 0;
}

function archiveName(platform = process.platform, arch = process.arch) {
  return ARCHIVES[`${platform}-${arch}`] ?? null;
}

function releaseUrls(tag, archive) {
  return {
    assetUrl: `${RELEASE_ROOT}/${tag}/${archive}`,
    checksumUrl: `${RELEASE_ROOT}/${tag}/${archive}.sha256`,
  };
}

function selectRelease(release, currentVersion, archive = archiveName()) {
  if (!Object.values(ARCHIVES).includes(archive)) return null;
  if (!release || typeof release !== "object" || Array.isArray(release)) return null;
  if (release.draft !== false || release.prerelease !== false) return null;

  const tagVersion = parseVersion(release.tag_name);
  const installedVersion = parseVersion(currentVersion);
  if (!tagVersion || !installedVersion) return null;
  if (compareVersions(release.tag_name, currentVersion) <= 0) return null;
  if (!Array.isArray(release.assets)) return null;

  const archives = release.assets.filter(item => item && item.name === archive);
  const checksums = release.assets.filter(item => item && item.name === `${archive}.sha256`);
  if (archives.length !== 1 || checksums.length !== 1) return null;

  const { assetUrl, checksumUrl } = releaseUrls(release.tag_name, archive);
  if (archives[0].browser_download_url !== assetUrl) return null;
  if (checksums[0].browser_download_url !== checksumUrl) return null;

  return {
    version: tagVersion.version,
    tag: release.tag_name,
    archive,
    assetUrl,
    checksumUrl,
  };
}

function validateSelectedRelease(release) {
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new TypeError("Invalid selected release");
  }
  const tagVersion = parseVersion(release.tag);
  const version = parseVersion(release.version);
  if (!tagVersion || !version || tagVersion.version !== version.version) {
    throw new TypeError("Invalid selected release version");
  }
  if (!Object.values(ARCHIVES).includes(release.archive)) throw new TypeError("Invalid selected release archive");
  const urls = releaseUrls(release.tag, release.archive);
  if (release.assetUrl !== urls.assetUrl || release.checksumUrl !== urls.checksumUrl) {
    throw new TypeError("Invalid selected release URL");
  }
}

function contentLength(response) {
  const raw = response?.headers?.get?.("content-length");
  if (raw === null || raw === undefined || raw === "") return null;
  if (!/^\d+$/.test(raw)) throw new Error("Invalid download content length");
  const size = Number(raw);
  if (!Number.isSafeInteger(size)) throw new Error("Invalid download content length");
  return size;
}

function requireSuccessfulResponse(response, label) {
  const successful = response?.ok === true
    || (response?.ok === undefined && Number.isInteger(response?.status)
      && response.status >= 200 && response.status < 300);
  if (!successful || !response.body) throw new Error(`Unable to download ${label}`);
  if (response.url) {
    let finalUrl;
    try {
      finalUrl = new URL(response.url);
    } catch {
      throw new Error(`Invalid ${label} response URL`);
    }
    if (finalUrl.protocol !== "https:") throw new Error(`${label} response must use HTTPS`);
  }
}

async function withTimedFetch(url, fetchImpl, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    return await consume(response, controller);
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response, maximum, label, controller) {
  requireSuccessfulResponse(response, label);
  const declared = contentLength(response);
  if (declared !== null && declared > maximum) {
    controller.abort();
    throw new Error(`${label} exceeds the size limit`);
  }
  const chunks = [];
  let size = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > maximum) {
      controller.abort();
      throw new Error(`${label} exceeds the size limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function parseChecksum(buffer, archive) {
  const text = buffer.toString("utf8");
  const match = /^([0-9a-fA-F]{64})[ \t]+\*?(?:\.\/)?([A-Za-z0-9.-]+)\r?\n?$/.exec(text);
  if (!match || match[2] !== archive) throw new Error("Invalid release checksum");
  return match[1].toLowerCase();
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new Error("Unable to write release archive");
    offset += bytesWritten;
  }
}

async function downloadArchive(response, temporaryPath, controller) {
  requireSuccessfulResponse(response, "release archive");
  const declared = contentLength(response);
  if (declared !== null && declared > MAX_ARCHIVE_BYTES) {
    controller.abort();
    throw new Error("Release archive exceeds the size limit");
  }

  const hash = crypto.createHash("sha256");
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  let size = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error("Release archive exceeds the size limit");
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

async function stageRelease(release, targetDir, { fetchImpl = globalThis.fetch } = {}) {
  validateSelectedRelease(release);
  if (typeof targetDir !== "string" || targetDir.length === 0) {
    throw new TypeError("A target directory is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");

  const expected = await withTimedFetch(release.checksumUrl, fetchImpl, async (response, controller) => {
    const body = await readBounded(response, MAX_CHECKSUM_BYTES, "release checksum", controller);
    return parseChecksum(body, release.archive);
  });

  const directory = path.resolve(targetDir);
  await fs.mkdir(directory, { recursive: true });
  const archivePath = path.join(directory, release.archive);
  const temporaryPath = path.join(directory, `.${release.archive}.${crypto.randomUUID()}.tmp`);

  try {
    const staged = await withTimedFetch(release.assetUrl, fetchImpl,
      (response, controller) => downloadArchive(response, temporaryPath, controller));
    if (!crypto.timingSafeEqual(Buffer.from(staged.sha256, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Release checksum does not match");
    }
    await fs.rename(temporaryPath, archivePath);
    return archivePath;
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  archiveName,
  compareVersions,
  selectRelease,
  stageRelease,
};
