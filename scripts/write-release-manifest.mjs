import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = /^[a-f0-9]{40}$/i;

async function filesUnder(root, relative = "") {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (name === "release-manifest.json") continue;
    if (entry.isDirectory()) files.push(...await filesUnder(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsupported package entry: ${name}`);
  }
  return files;
}

export async function createReleaseManifest(root, { version, platform, sourceCommit, upstreamCommit, coreSourceCommit = sourceCommit }) {
  if (!COMMIT.test(sourceCommit) || !COMMIT.test(upstreamCommit) || !COMMIT.test(coreSourceCommit)) {
    throw new Error("Release manifest requires full source, core build, and upstream commits");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("Invalid release version");
  if (!/^(windows-x64|macos-x64|macos-arm64|linux-x64)$/.test(platform)) {
    throw new Error("Invalid release platform");
  }
  const files = {};
  for (const name of (await filesUnder(root)).sort()) {
    const bytes = await fs.readFile(path.join(root, name));
    files[name] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  if (!Object.hasOwn(files, `dist/${platform}/codex-zero-core${platform === "windows-x64" ? ".exe" : ""}`)) {
    throw new Error("Release package is missing its platform core");
  }
  const manifest = {
    schema: "codex-zero-release-v1",
    version,
    platform,
    source: { repository: "Retro2512/CodexZero", commit: sourceCommit.toLowerCase() },
    core: { sourceCommit: coreSourceCommit.toLowerCase() },
    upstream: { repository: "openai/codex", commit: upstreamCommit.toLowerCase() },
    files
  };
  await fs.writeFile(path.join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, version, platform, sourceCommit, upstreamCommit, coreSourceCommit] = process.argv.slice(2);
  try {
    await createReleaseManifest(root, { version, platform, sourceCommit, upstreamCommit, coreSourceCommit });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
