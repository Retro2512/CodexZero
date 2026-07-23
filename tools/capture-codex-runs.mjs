import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const codexBinary = option("--bin");
const outputRoot = resolve(
  option(
    "--output",
    join(repositoryRoot, "private-artifacts", "codex-runs"),
  ),
);
const reasoningSummary = option("--reasoning-summary", "auto");
const codexHome = resolve(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
);
const artifactRoot = join(outputRoot, "store", "sha256");

if (!codexBinary) {
  throw new Error("--bin is required");
}

const cases = [
  {
    id: "silent-60",
    prompt:
      "Run `node fixtures/silent-60.js 60000`, wait until it exits, then report its exit code. Do not run any other command.",
  },
  {
    id: "repeated-lines",
    prompt:
      "Run `node fixtures/repeated-lines.js 250`. Preserve and inspect its complete output, then report the exit code. Do not run any other command.",
  },
  {
    id: "ansi-output",
    prompt:
      "Run `node fixtures/ansi-output.js`. Preserve and inspect its complete output, then report the exit code. Do not run any other command.",
  },
  {
    id: "unchanged-read-twice",
    prompt:
      "Read `fixtures/unchanged.txt` twice using two separate complete shell commands. Do not modify it. Report whether both byte sequences match.",
  },
  {
    id: "git-status-twice",
    prompt:
      "Run `git status --short --branch` twice using two separate shell commands. Report whether both complete outputs match.",
  },
  {
    id: "validation-sequence",
    prompt:
      "Run these three commands separately and in order: `node --check app.js`, `git diff --check`, and `node fixtures/repeated-lines.js 3`. Report every exit code.",
  },
  {
    id: "failing-stack",
    prompt:
      "Run `node fixtures/failing-stack.js`. Preserve and inspect the complete failure output, then report its exit code. Do not run any other command.",
  },
];

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

function runCodex(prompt) {
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      "--strict-config",
      "-c",
      `model_reasoning_summary="${reasoningSummary}"`,
      "-s",
      "read-only",
      "-a",
      "never",
      "-C",
      repositoryRoot,
      "exec",
      "--json",
      "--skip-git-repo-check",
      prompt,
    ];
    const startedAt = process.hrtime.bigint();
    const child = spawn(codexBinary, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", rejectRun);
    child.on("close", (exitCode, signal) => {
      const finishedAt = process.hrtime.bigint();
      resolveRun({
        exitCode,
        signal,
        wallTimeMs: Number(finishedAt - startedAt) / 1_000_000,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

async function findSessionFile(threadId, directory = join(codexHome, "sessions")) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = await findSessionFile(threadId, path);
      if (match) {
        return match;
      }
    } else if (entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
      return path;
    }
  }

  return null;
}

function parseJsonLines(bytes) {
  return bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function inspectSession(sessionPath) {
  const raw = await readFile(sessionPath);
  const items = parseJsonLines(raw);
  const seenUsage = new Set();
  const toolOutputs = [];
  let finalUsage = null;
  let model = null;
  let effort = null;
  let summary = null;

  for (const item of items) {
    const payload = item.payload ?? {};
    if (item.type === "turn_context") {
      model = payload.model ?? model;
      effort = payload.effort ?? effort;
      summary = payload.summary ?? summary;
    }
    if (item.type === "event_msg" && payload.type === "token_count") {
      const usage = payload.info?.total_token_usage;
      if (usage?.total_tokens) {
        seenUsage.add(JSON.stringify(usage));
        finalUsage = usage;
      }
    }
    if (
      item.type === "response_item" &&
      ["function_call_output", "custom_tool_call_output"].includes(payload.type)
    ) {
      const output =
        typeof payload.output === "string"
          ? payload.output
          : JSON.stringify(payload.output);
      toolOutputs.push(await storeArtifact(Buffer.from(output ?? "", "utf8")));
    }
  }

  return {
    path: sessionPath,
    file: await storeArtifact(raw),
    inferenceRequests: seenUsage.size,
    finalUsage,
    toolOutputs,
    model,
    effort,
    summary,
  };
}

async function main() {
  await mkdir(outputRoot, { recursive: true });
  const runs = [];

  for (const fixture of cases) {
    process.stderr.write(`Running ${fixture.id}\n`);
    const result = await runCodex(fixture.prompt);
    const stdoutEvents = parseJsonLines(result.stdout);
    const threadId = stdoutEvents.find(
      (event) => event.type === "thread.started",
    )?.thread_id;
    const turn = stdoutEvents.find(
      (event) => event.type === "turn.completed",
    );
    const failure = stdoutEvents.find(
      (event) => event.type === "turn.failed",
    );
    let session = null;

    if (threadId) {
      const sessionPath = await findSessionFile(threadId);
      if (sessionPath) {
        session = await inspectSession(sessionPath);
      }
    }

    runs.push({
      id: fixture.id,
      prompt: fixture.prompt,
      command: {
        binary: codexBinary,
        reasoningSummary,
      },
      exitCode: result.exitCode,
      signal: result.signal,
      wallTimeMs: result.wallTimeMs,
      stdout: await storeArtifact(result.stdout),
      stderr: await storeArtifact(result.stderr),
      threadId,
      result: turn ?? failure ?? null,
      session,
    });
  }

  const manifest = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    codexBinary,
    reasoningSummary,
    runs,
  };
  const manifestPath = join(outputRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${manifestPath}\n`);
}

await main();
