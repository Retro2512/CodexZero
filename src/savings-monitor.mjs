import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TelemetryReader } from "./telemetry-reader.mjs";
import { statePath, telemetryPath } from "./paths.mjs";

export async function startSavingsMonitor({
  file = telemetryPath(), destination = statePath(), intervalMs = 5000,
  onError = (error) => console.error(`CodexZero: ${error.message}`)
} = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 250 || intervalMs > 2_147_483_647) {
    throw new Error("Monitor interval must be between 250 and 2147483647 ms");
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const reader = new TelemetryReader(file);
  let closed = false;
  let timer;
  let active;
  let dirty = false;
  let lastWritten;
  const refresh = async () => {
    dirty = true;
    if (active) return active;
    active = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const summary = `${JSON.stringify(await reader.read(), null, 2)}\n`;
        if (summary === lastWritten) continue;
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, summary, { mode: 0o600 });
          await fs.rename(temporary, destination);
          lastWritten = summary;
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
    })();
    try { await active; } finally { active = undefined; }
  };
  const schedule = () => {
    if (closed || timer) return;
    // Throttle rather than debounce so continuous writes cannot starve updates.
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch(onError);
    }, intervalMs);
  };
  const watcher = fsSync.watch(path.dirname(file), (_event, filename) => {
    if (!filename || filename.toString() === path.basename(file)) schedule();
  });
  watcher.on("error", onError);
  // Filesystem notifications can be lost during rotation or on network drives.
  const fallback = setInterval(() => void refresh().catch(onError), Math.max(intervalMs, 5000));
  const close = async () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(fallback);
    watcher.close();
    await active?.catch(() => {});
  };
  try { await refresh(); } catch (error) { await close(); throw error; }
  return { refresh, close, reader };
}
