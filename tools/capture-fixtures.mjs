import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");
const outputRoot = resolve(
  process.argv[2] ?? join(repositoryRoot, "private-artifacts", "fixture-baseline"),
);
const artifactRoot = join(outputRoot, "store", "sha256");

async function storeArtifact(bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = join(artifactRoot, hash);

  await mkdir(artifactRoot, { recursive: true });
  try {
    await stat(path);
  } catch {
    await writeFile(path, bytes);
  }

  return {
    sha256: hash,
    bytes: bytes.length,
    path: path.slice(outputRoot.length + 1).replaceAll("\\", "/"),
  };
}

function runProcess(program, args, cwd = repositoryRoot) {
  return new Promise((resolveRun, rejectRun) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(program, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const ordered = [];

    child.stdout.on("data", (chunk) => {
      const copy = Buffer.from(chunk);
      stdout.push(copy);
      ordered.push(copy);
    });
    child.stderr.on("data", (chunk) => {
      const copy = Buffer.from(chunk);
      stderr.push(copy);
      ordered.push(copy);
    });
    child.on("error", rejectRun);
    child.on("close", (exitCode, signal) => {
      const finishedAt = process.hrtime.bigint();
      resolveRun({
        exitCode,
        signal,
        wallTimeMs: Number(finishedAt - startedAt) / 1_000_000,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        combined: Buffer.concat(ordered),
      });
    });
  });
}

async function captureProcess(id, program, args, cwd = repositoryRoot) {
  const result = await runProcess(program, args, cwd);

  return {
    id,
    command: { program, args, cwd },
    exitCode: result.exitCode,
    signal: result.signal,
    wallTimeMs: result.wallTimeMs,
    stdout: await storeArtifact(result.stdout),
    stderr: await storeArtifact(result.stderr),
    combined: await storeArtifact(result.combined),
  };
}

async function main() {
  await mkdir(outputRoot, { recursive: true });

  const checks = JSON.parse(
    await readFile(join(repositoryRoot, "fixtures", "checks.json"), "utf8"),
  ).fixture.commands;
  const captures = [];

  captures.push(
    await captureProcess("silent-60", process.execPath, [
      "fixtures/silent-60.js",
      "60000",
    ]),
  );
  captures.push(
    await captureProcess("repeated-lines", process.execPath, [
      "fixtures/repeated-lines.js",
      "250",
    ]),
  );
  captures.push(
    await captureProcess("ansi-output", process.execPath, [
      "fixtures/ansi-output.js",
    ]),
  );
  captures.push(
    await captureProcess("unchanged-read-1", process.execPath, [
      "-e",
      "process.stdout.write(require('fs').readFileSync('fixtures/unchanged.txt'))",
    ]),
  );
  captures.push(
    await captureProcess("unchanged-read-2", process.execPath, [
      "-e",
      "process.stdout.write(require('fs').readFileSync('fixtures/unchanged.txt'))",
    ]),
  );
  captures.push(
    await captureProcess("git-status-1", "git", ["status", "--short", "--branch"]),
  );
  captures.push(
    await captureProcess("git-status-2", "git", ["status", "--short", "--branch"]),
  );

  for (const [index, check] of checks.entries()) {
    captures.push(
      await captureProcess(
        `validation-${index + 1}`,
        check.program,
        check.args,
      ),
    );
  }

  captures.push(
    await captureProcess("failing-stack", process.execPath, [
      "fixtures/failing-stack.js",
    ]),
  );

  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    repositoryRoot,
    captures,
  };
  const manifestPath = join(outputRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${manifestPath}\n`);
}

await main();
