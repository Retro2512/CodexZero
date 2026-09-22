import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import updater from "../assets/native-provider-update-release.cjs";

const { compareVersions, selectRelease, stageRelease } = updater;
const archiveName = "codex-zero-windows-x64.zip";

function githubRelease(tag = "v1.2.0") {
  const root = `https://github.com/Retro2512/CodexZero/releases/download/${tag}`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      { name: archiveName, browser_download_url: `${root}/${archiveName}` },
      { name: `${archiveName}.sha256`, browser_download_url: `${root}/${archiveName}.sha256` },
    ],
  };
}

test("compareVersions accepts only stable semantic versions", () => {
  assert.equal(compareVersions("v1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.3+build.9", "v1.2.3+other"), 0);
  assert.equal(compareVersions("1.999999999999999999999.0", "2.0.0"), -1);
  for (const malformed of ["1.2", "1.2.3-beta.1", "01.2.3", " 1.2.3", "V1.2.3", 1]) {
    assert.throws(() => compareVersions(malformed, "1.0.0"), TypeError);
  }
});

test("selectRelease accepts only a newer complete release from the canonical repository", () => {
  assert.deepEqual(selectRelease(githubRelease(), "1.1.9"), {
    version: "1.2.0",
    tag: "v1.2.0",
    assetUrl: `https://github.com/Retro2512/CodexZero/releases/download/v1.2.0/${archiveName}`,
    checksumUrl: `https://github.com/Retro2512/CodexZero/releases/download/v1.2.0/${archiveName}.sha256`,
  });
  assert.equal(selectRelease(githubRelease(), "1.2.0"), null);
  assert.equal(selectRelease(githubRelease("v1.1.9"), "1.2.0"), null);
});

test("selectRelease fails closed for malformed metadata, tags, and URLs", () => {
  const mutations = [
    release => { release.draft = true; },
    release => { release.prerelease = true; },
    release => { release.tag_name = "v1.2.0-rc.1"; },
    release => { release.tag_name = "01.2.0"; },
    release => { release.assets[0].name = "CodexZero.zip"; },
    release => { release.assets.pop(); },
    release => { release.assets.push({ ...release.assets[0] }); },
    release => { release.assets[0].browser_download_url = "http://github.com/Retro2512/CodexZero/releases/download/v1.2.0/codex-zero-windows-x64.zip"; },
    release => { release.assets[0].browser_download_url = "https://github.com/attacker/CodexZero/releases/download/v1.2.0/codex-zero-windows-x64.zip"; },
    release => { release.assets[1].browser_download_url = `https://github.com/Retro2512/CodexZero/releases/download/v9.0.0/${archiveName}.sha256`; },
  ];
  for (const mutate of mutations) {
    const release = githubRelease();
    mutate(release);
    assert.equal(selectRelease(release, "1.1.0"), null);
  }
  assert.equal(selectRelease(githubRelease(), "not-a-version"), null);
});

test("stageRelease streams a verified archive into place", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-update-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archive = Buffer.from("PK\x03\x04fixture archive bytes");
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  const selected = selectRelease(githubRelease(), "1.1.0");
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, options });
    if (url === selected.checksumUrl) {
      return new Response(`${digest}  ./${archiveName}\n`);
    }
    if (url === selected.assetUrl) return new Response(archive);
    throw new Error("unexpected URL");
  };

  const staged = await stageRelease(selected, directory, { fetchImpl });
  assert.equal(staged, path.join(directory, archiveName));
  assert.deepEqual(await fs.readFile(staged), archive);
  assert.deepEqual(requested.map(request => request.url), [selected.checksumUrl, selected.assetUrl]);
  assert.ok(requested.every(request => request.options.signal instanceof AbortSignal));
  assert.deepEqual(await fs.readdir(directory), [archiveName]);
});

test("stageRelease rejects malformed checksum files and removes temporary archives", async t => {
  const cases = [
    `${"a".repeat(63)}  ${archiveName}\n`,
    `${"a".repeat(64)}  another.zip\n`,
    `${"a".repeat(64)}  ${archiveName}\nextra`,
  ];
  for (const checksum of cases) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-update-bad-checksum-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const selected = selectRelease(githubRelease(), "1.1.0");
    let archiveRequested = false;
    await assert.rejects(stageRelease(selected, directory, {
      fetchImpl: async url => {
        if (url === selected.checksumUrl) return new Response(checksum);
        archiveRequested = true;
        return new Response("archive");
      },
    }), /checksum/i);
    assert.equal(archiveRequested, false);
    assert.deepEqual(await fs.readdir(directory).catch(() => []), []);
  }
});

test("stageRelease never promotes an archive whose digest does not match", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-update-mismatch-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const selected = selectRelease(githubRelease(), "1.1.0");
  await assert.rejects(stageRelease(selected, directory, {
    fetchImpl: async url => url === selected.checksumUrl
      ? new Response(`${"0".repeat(64)}  ${archiveName}\n`)
      : new Response("not the expected archive"),
  }), /does not match/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test("stageRelease enforces canonical URLs and download size bounds", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-update-bounds-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const selected = selectRelease(githubRelease(), "1.1.0");
  await assert.rejects(stageRelease({ ...selected, assetUrl: "https://example.com/update.zip" }, directory, {
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }), /URL/);
  await assert.rejects(stageRelease(selected, directory, {
    fetchImpl: async () => new Response("x", { headers: { "content-length": "1073741825" } }),
  }), /size limit/);
});

test("stageRelease rejects a final response URL that downgrades HTTPS", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-update-downgrade-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const selected = selectRelease(githubRelease(), "1.1.0");
  const response = new Response(`${"0".repeat(64)}  ${archiveName}\n`);
  Object.defineProperty(response, "url", { value: "http://release-assets.githubusercontent.com/archive.sha256" });
  await assert.rejects(stageRelease(selected, directory, {
    fetchImpl: async () => response,
  }), /must use HTTPS/);
});
