import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const PROBE_TIMEOUT_MS = 10_000;
const DESKTOP_STARTUP_MS = 1_500;
const MAX_OUTPUT_BYTES = 64 * 1024;

function failure(label, detail, stderr) {
  const message = stderr.trim();
  return new Error(`${label}: ${detail}${message ? `\n${message}` : ""}`);
}

function captureStderr(child) {
  let output = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    output = (output + chunk).slice(-MAX_OUTPUT_BYTES);
  });
  return () => output;
}

async function stopProbe(child) {
  if (!child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = waitForClose(child, 500);
  child.kill();
  if (await closed) return;
  const forcedClosed = waitForClose(child, 500);
  child.kill("SIGKILL");
  if (!(await forcedClosed)) throw new Error("Core startup probe could not be stopped");
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolve) => {
    const done = (closed) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("close", onClose);
  });
}

export async function verifyAppServer(binary, env, {
  timeoutMs = PROBE_TIMEOUT_MS,
  spawnProcess = spawn
} = {}) {
  const child = spawnProcess(binary, ["app-server", "--stdio"], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stderr = captureStderr(child);
  child.stdin.on("error", () => {});
  let timer;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let output = "";
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => done(failure("Core startup failed", "initialize timed out", stderr())), timeoutMs);
      child.once("error", (error) => done(failure("Core startup failed", error.message, stderr())));
      child.once("exit", (code, signal) => done(failure(
        "Core startup failed", `app-server exited (${signal || code}) before initialize`, stderr()
      )));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > MAX_OUTPUT_BYTES) {
          done(failure("Core startup failed", "app-server response exceeded the limit", stderr()));
          return;
        }
        for (let newline; (newline = output.indexOf("\n")) !== -1;) {
          const line = output.slice(0, newline).trim();
          output = output.slice(newline + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); }
          catch {
            done(failure("Core startup failed", "invalid app-server response", stderr()));
            return;
          }
          if (message.id !== 1) continue;
          if (message.error || !message.result) {
            done(failure("Core startup failed", message.error?.message || "initialize was rejected", stderr()));
            return;
          }
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          done();
          return;
        }
      });
      child.once("spawn", () => {
        child.stdin.write(`${JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "codex-zero-startup", version: "1" } }
        })}\n`);
      });
    });
  } finally {
    clearTimeout(timer);
    await stopProbe(child);
  }
}

export async function startVerifiedDesktop(binary, env, {
  logPath,
  startupMs = DESKTOP_STARTUP_MS,
  spawnProcess = spawn
} = {}) {
  if (!logPath) throw new Error("Desktop startup log path is required");
  await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.lstat(logPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Desktop startup log must be a regular file");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC |
    (constants.O_NOFOLLOW ?? 0);
  const log = await fs.open(logPath, flags, 0o600);
  let child;
  let startup;
  try {
    await log.chmod(0o600);
    child = spawnProcess(binary, [], {
      detached: true,
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", log.fd]
    });
    startup = new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", (error) => done(error));
      child.once("exit", (code, signal) => done(new Error(
        `process exited (${signal || code}) during startup`
      )));
      child.once("spawn", () => {
        timer = setTimeout(() => done(), startupMs);
      });
    });
    startup.catch(() => {});
  } finally {
    await log.close();
  }
  await startup.catch(async (error) => {
    throw failure("Desktop startup failed", error.message, await readLogTail(logPath));
  });
  child.unref();
  return child;
}

async function readLogTail(logPath) {
  try {
    const handle = await fs.open(logPath, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, MAX_OUTPUT_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}
