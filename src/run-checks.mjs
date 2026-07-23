import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { storeRaw } from "./artifact-store.mjs";

export async function runChecks(profileName, options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const configuration = await loadConfiguration(cwd, options.config);
  const profile = configuration.profiles?.[profileName] ?? configuration[profileName];
  const commands = Array.isArray(profile) ? profile : profile?.commands;
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error(`Unknown or empty check profile: ${profileName}`);
  }

  const startedAt = Date.now();
  const results = [];
  for (const [index, command] of commands.entries()) {
    const normalized = normalizeCommand(command);
    options.onProgress?.({
      profile: profileName,
      current: index + 1,
      total: commands.length,
      command: normalized.display
    });
    const result = await runOne(normalized, cwd);
    const combinedArtifact = await storeRaw(result.combined);
    const stdoutArtifact = await storeRaw(result.stdout);
    const stderrArtifact = await storeRaw(result.stderr);
    results.push({
      command: normalized.display,
      exitCode: result.exitCode,
      signal: result.signal,
      wallTimeMs: result.wallTimeMs,
      artifacts: {
        combined: combinedArtifact,
        stdout: stdoutArtifact,
        stderr: stderrArtifact
      },
      stdout: modelOutput(result.stdout),
      stderr: modelOutput(result.stderr)
    });
    if (result.exitCode !== 0 && !(profile?.continueOnFailure ?? configuration.continueOnFailure)) {
      break;
    }
  }

  return {
    schema: "codex-zero-run-checks-v1",
    profile: profileName,
    cwd,
    startedAtMs: startedAt,
    wallTimeMs: Date.now() - startedAt,
    success: results.length === commands.length && results.every((item) => item.exitCode === 0),
    commands: results
  };
}

function modelOutput(bytes) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes)) {
    return { encoding: "utf8", text };
  }
  return { encoding: "base64", text: bytes.toString("base64") };
}

async function loadConfiguration(cwd, explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(cwd, explicitPath)]
    : [
        path.join(cwd, ".codex", "checks.json"),
        path.join(cwd, "codexzero.checks.json"),
        path.join(cwd, "fixtures", "checks.json")
      ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`No check configuration found under ${cwd}`);
}

function normalizeCommand(command) {
  if (typeof command === "string") {
    return process.platform === "win32"
      ? { file: "powershell.exe", args: ["-NoProfile", "-Command", command], display: command }
      : { file: "/bin/sh", args: ["-lc", command], display: command };
  }
  const file = command?.file ?? command?.program;
  if (command && typeof file === "string" && Array.isArray(command.args)) {
    return {
      file,
      args: command.args.map(String),
      display: command.display || [file, ...command.args].join(" ")
    };
  }
  throw new Error("Each check must be a shell string or {file,args} object");
}

function runOne(command, cwd) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command.file, command.args, {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    const combined = [];
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stdout.push(bytes);
      combined.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.from(chunk);
      stderr.push(bytes);
      combined.push(bytes);
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      exitCode,
      signal,
      wallTimeMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      combined: Buffer.concat(combined)
    }));
  });
}
