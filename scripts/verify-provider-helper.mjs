import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { sanitizedChildEnvironment } from "../src/core-compatibility.mjs";

// Exercise the same stdio initialize request used by isolated browser helpers.
// Do not send thread or turn requests, use the user's account, or call a model.
export async function verifyProviderHelper(launcher, { environment = process.env, timeoutMs = 30_000 } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cz-helper-startup-"));
  const env = sanitizedChildEnvironment({ home, providerHome: path.join(home, "provider"), sqliteHome: path.join(home, "sqlite") }, environment);
  delete env.CODEX_ZERO_PROVIDER_CORE;
  delete env.CODEX_ZERO_CORE_BINDING;
  let child, lines, timer;
  try {
    child = spawn(launcher, ["app-server", "--listen", "stdio://"], { env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
    const closed = new Promise(resolve => child.once("close", resolve));
    lines = createInterface({ input: child.stdout });
    const result = await new Promise((resolve, reject) => {
      const fail = message => reject(new Error(`${message}${stderr ? `: ${stderr}` : ""}`));
      timer = setTimeout(() => fail("Browser helper initialization timed out"), timeoutMs);
      child.once("error", reject);
      child.once("exit", code => fail(`Browser helper exited before initialization (${code})`));
      child.stdin.on("error", reject);
      lines.on("line", line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 1) return;
        if (message.error) fail(JSON.stringify(message.error));
        else if (!message.result || typeof message.result !== "object") fail("Browser helper initialization response is invalid");
        else resolve(message.result);
      });
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {
        clientInfo: { name: "codex-browser-use", title: "Codex Browser Use", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      } }) + "\n");
    });
    clearTimeout(timer);
    child.stdin.end(JSON.stringify({ method: "initialized" }) + "\n");
    let exitTimer;
    const exited = await Promise.race([closed.then(() => true), new Promise(resolve => { exitTimer = setTimeout(() => resolve(false), 5000); })]);
    clearTimeout(exitTimer);
    if (!exited) throw new Error("Browser helper did not stop after initialization");
    if (child.exitCode !== 0) throw new Error(`Browser helper exited with ${child.exitCode}`);
    return result;
  } finally {
    clearTimeout(timer);
    lines?.close();
    if (child?.pid && child.exitCode == null && child.signalCode == null) {
      if (process.platform === "win32") {
        await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group already exited. */ }
      }
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
