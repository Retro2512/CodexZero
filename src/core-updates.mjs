import fs from "node:fs";
import fsp from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { codexZeroHome } from "./paths.mjs";
import { prepareProviderContextCore } from "./provider-core-context.mjs";

const execFileAsync = promisify(execFile);
const names = ["codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "codex-windows-sandbox-service.exe", "rg.exe"];
const mandatory = names.slice(0, 4);
const hex = /^[a-f0-9]{8,64}$/i;
const sha = /^[a-f0-9]{64}$/;
const interval = 30 * 60_000;
const packageVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function context(options = {}) {
  const home = path.resolve(options.home || path.join(codexZeroHome(), "core-updates"));
  return { home, platform: options.platform || process.platform,
    stockRoot: options.stockRoot ? path.resolve(options.stockRoot) :
      (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : null) };
}

function enabled(options) { return (options.environment || process.env).CODEX_ZERO_CORE_UPDATES !== "0"; }

function stamp(file) {
  const s = fs.statSync(file);
  if (!s.isFile()) throw new Error("Not a core file");
  return { size: s.size, mtimeMs: s.mtimeMs };
}

function sameStamp(a, b) {
  return a && b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function identity(fallback, options) {
  return { path: path.resolve(fallback), ...stamp(fallback), releaseId: `${packageVersion}:${options.releaseId || ""}` };
}

function readState(home) {
  try {
    const file = path.join(home, "state.json");
    if (fs.statSync(file).size > 32_768) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data?.schema === 1 && typeof data === "object" ? data : null;
  } catch { return null; }
}

function validEntry(home, entry) {
  if (!entry || !sha.test(entry.id) || !entry.files || typeof entry.files !== "object") return null;
  if (!Array.isArray(entry.names) || !entry.names.includes("codex.exe") ||
    !["codex.exe", "codex-provider-context.exe"].includes(entry.selected) || !entry.names.includes(entry.selected) ||
    entry.names.length > names.length + 1 || entry.names.some(n => ![...names, "codex-provider-context.exe"].includes(n)) ||
    new Set(entry.names).size !== entry.names.length) return null;
  const dir = path.join(home, "cache", entry.id);
  try {
    const cacheReal = fs.realpathSync(path.join(home, "cache"));
    const dirReal = fs.realpathSync(dir);
    if (path.dirname(dirReal).toLowerCase() !== cacheReal.toLowerCase() || path.basename(dirReal).toLowerCase() !== entry.id) return null;
    for (const name of entry.names) {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isSymbolicLink() || !sameStamp(stamp(file), entry.files[name])) return null;
    }
    return path.join(dir, entry.selected);
  } catch { return null; }
}

// This is intentionally only small local metadata and stat reads on the launch path.
export function selectUpdatedCore(fallback, options = {}) {
  if (!enabled(options) || context(options).platform !== "win32") return fallback;
  try {
    const { home } = context(options);
    const state = readState(home);
    if (!state || !sameIdentity(state.base, identity(fallback, options))) return fallback;
    return validEntry(home, state.active) || validEntry(home, state.previous) || fallback;
  } catch { return fallback; }
}

function sameIdentity(a, b) {
  return a?.path === b?.path && a?.releaseId === b?.releaseId && sameStamp(a, b);
}

async function atomicState(home, state) {
  await fsp.mkdir(home, { recursive: true });
  const temp = path.join(home, `.state-${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await fsp.rename(temp, path.join(home, "state.json"));
  } finally { await fsp.rm(temp, { force: true }); }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; }
}

async function lock(home) {
  await fsp.mkdir(home, { recursive: true });
  const file = path.join(home, "worker.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fsp.open(file, "wx", 0o600);
      const token = randomUUID();
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
      finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await fsp.readFile(file, "utf8"));
          if (current.token === token) await fsp.rm(file, { force: true });
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const guardFile = path.join(home, "worker-reaper.lock");
      let guard;
      try { guard = await fsp.open(guardFile, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        // A crashed reaper is recoverable, but never displace a recent one.
        try {
          const s = await fsp.stat(guardFile);
          if (Date.now() - s.mtimeMs > 60_000) await fsp.rm(guardFile, { force: true });
        } catch {}
        return null;
      }
      try {
        let old;
        try { old = JSON.parse(await fsp.readFile(file, "utf8")); }
        catch {
          // Give a live writer time to finish, but recover an interrupted write.
          const info = await fsp.stat(file).catch(() => null);
          if (!info || Date.now() - info.mtimeMs < 60_000) return null;
        }
        if (alive(old?.pid)) return null;
        await fsp.rm(file, { force: true });
      } finally {
        await guard.close();
        await fsp.rm(guardFile, { force: true });
      }
    }
  }
  return null;
}

export async function verifyOfficialCoreSignature(file, { environment = process.env, execute = execFileAsync } = {}) {
  const quoted = file.replaceAll("'", "''");
  const script = `$s=Get-AuthenticodeSignature -LiteralPath '${quoted}'; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -eq 'OpenAI OpCo, LLC') { 'VALID' } else { 'INVALID' }`;
  const powershell = path.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // A parent pwsh session can export PowerShell 7 modules that Windows
  // PowerShell cannot load. Use its own built-in security module, not PATH.
  const { stdout } = await execute(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 15_000, windowsHide: true, maxBuffer: 4096,
      env: { ...environment, PSModulePath: path.join(path.dirname(powershell), "Modules") } });
  return stdout.trim() === "VALID";
}

async function defaultVersion(file) {
  const { stdout } = await execFileAsync(file, ["--version"], { timeout: 10_000, windowsHide: true, maxBuffer: 4096 });
  return stdout.trim();
}

function version(value) {
  const match = /^(?:codex-cli\s+)?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(String(value).trim());
  if (!match) throw new Error("Invalid core version");
  const numeric = match.slice(1, 4).map(Number);
  if (numeric.some(n => !Number.isSafeInteger(n)) || match[4]?.split(".").some(v => /^\d+$/.test(v) && (v.length > 1 && v.startsWith("0") || !Number.isSafeInteger(Number(v)))))
    throw new Error("Invalid core version");
  return [...numeric, match[4] || ""];
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  if (!a[3]) return Boolean(b[3]);
  if (!b[3]) return false;
  const x = a[3].split("."), y = b[3].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return false;
    if (y[i] === undefined) return true;
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]), ny = /^\d+$/.test(y[i]);
    if (nx && ny) return Number(x[i]) > Number(y[i]);
    if (nx !== ny) return !nx;
    return x[i] > y[i];
  }
  return false;
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function candidates(stockRoot) {
  if (!stockRoot) return [];
  let entries;
  try { entries = await fsp.readdir(stockRoot, { withFileTypes: true }); }
  catch { return []; }
  const result = [];
  for (const e of entries) {
    if (!e.isDirectory() || !hex.test(e.name)) continue;
    const file = path.join(stockRoot, e.name, "codex.exe");
    try {
      const info = await fsp.lstat(file);
      if (info.isFile()) result.push({ dir: path.dirname(file), mtime: info.mtimeMs });
    } catch {}
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}

async function removeUnusedCache(home, id, protectedIds) {
  if (!sha.test(id) || protectedIds.includes(id)) return;
  try {
    const root = await fsp.realpath(path.join(home, "cache"));
    const dir = await fsp.realpath(path.join(root, id));
    if (path.dirname(dir).toLowerCase() !== root.toLowerCase() || path.basename(dir).toLowerCase() !== id) return;
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { /* Windows can retain files opened by another process. */ }
}

async function copyCandidate(source, home, verifySignature, prepareCore, protectedIds) {
  const stage = path.join(home, `stage-${randomUUID()}`);
  await fsp.mkdir(stage, { recursive: true });
  let promotedId;
  try {
    const files = {}, hashes = {};
    for (const name of names) {
      const input = path.join(source, name), output = path.join(stage, name);
      let before;
      try { before = await fsp.lstat(input); } catch { continue; }
      if (!before.isFile() || !(await verifySignature(input))) throw new Error("Stock signature rejected");
      const sourceHash = await hashFile(input);
      await pipeline(createReadStream(input), createWriteStream(output, { flags: "wx" }));
      if (sourceHash !== await hashFile(output) || sourceHash !== await hashFile(input) ||
        !sameStamp(before, await fsp.lstat(input)) || !(await verifySignature(output))) throw new Error("Stock copy changed");
      files[name] = stamp(output);
      hashes[name] = sourceHash;
    }
    if (mandatory.some(name => !files[name])) throw new Error("Incomplete stock core");
    const prepared = path.resolve(await prepareCore(path.join(stage, "codex.exe")));
    const preparedReal = await fsp.realpath(prepared);
    const stageReal = await fsp.realpath(stage);
    const selected = path.basename(preparedReal);
    if (!["codex.exe", "codex-provider-context.exe"].includes(selected) ||
      path.dirname(preparedReal).toLowerCase() !== stageReal.toLowerCase() ||
      (await fsp.lstat(prepared)).isSymbolicLink()) {
      throw new Error("Prepared core escaped staging");
    }
    if (!files[selected]) {
      files[selected] = stamp(prepared);
      hashes[selected] = await hashFile(prepared);
    }
    const id = createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
    const dir = path.join(home, "cache", id);
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    try { await fsp.rename(stage, dir); promotedId = id; }
    catch (e) {
      if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(e.code) || !(await fsp.stat(dir).catch(() => null))?.isDirectory()) throw e;
      for (const name of Object.keys(files)) {
        if (await hashFile(path.join(dir, name)) !== hashes[name]) throw new Error("Cached core differs");
        files[name] = stamp(path.join(dir, name));
      }
    }
    const entry = { id, selected, names: Object.keys(files), files, selectedSha256: hashes[selected] };
    if (!validEntry(home, entry)) throw new Error("Cached core invalid");
    return { entry, created: Boolean(promotedId) };
  } catch (error) {
    if (promotedId) await removeUnusedCache(home, promotedId, protectedIds);
    throw error;
  } finally { await fsp.rm(stage, { recursive: true, force: true }); }
}

export async function checkForCoreUpdate(fallback, options = {}) {
  const { home, stockRoot, platform } = context(options);
  if (platform !== "win32" || !enabled(options)) return { status: "unsupported" };
  const unlock = await lock(home);
  if (!unlock) return { status: "busy" };
  let state;
  try {
    const base = identity(fallback, options);
    const existing = readState(home);
    state = existing && sameIdentity(existing.base, base) ? existing : { schema: 1, base };
    const now = options.now?.() ?? Date.now();
    if (!options.force && Number.isFinite(state.checkedAt) && now - state.checkedAt < interval && now >= state.checkedAt)
      return { status: "throttled" };
    state.checkedAt = now;
    const verifySignature = options.verifySignature || verifyOfficialCoreSignature;
    const readVersion = options.readVersion || defaultVersion;
    const prepareCore = options.prepareCore || (file => prepareProviderContextCore(file, { allowCompatible: true }));
    const verify = options.verifyCoreCompatibility || (await import("./core-compatibility.mjs")).verifyCoreCompatibility;
    const baseline = validEntry(home, state.active) || validEntry(home, state.previous) || fallback;
    let minimum = version(await readVersion(baseline));
    for (const candidate of (await candidates(stockRoot)).slice(0, 4)) {
      let staged;
      try {
        const source = path.join(candidate.dir, "codex.exe");
        if (!(await verifySignature(source))) continue;
        const next = version(await readVersion(source));
        if (!newer(next, minimum)) continue;
        const protectedIds = [state.active?.id, state.previous?.id];
        staged = await copyCandidate(candidate.dir, home, verifySignature, prepareCore, protectedIds);
        const { entry } = staged;
        const copied = path.join(home, "cache", entry.id, entry.selected);
        if (version(await readVersion(copied)).join(".") !== next.join(".")) throw new Error("Copied version differs");
        await verify(copied, { baseline });
        const nextState = { ...state,
          previous: validEntry(home, state.active) ? state.active : (validEntry(home, state.previous) ? state.previous : null),
          active: entry };
        await atomicState(home, nextState);
        state = nextState;
        return { status: "updated", core: copied };
      } catch {
        if (staged?.created) await removeUnusedCache(home, staged.entry.id, [state.active?.id, state.previous?.id]);
        // Another stock extraction may be incomplete. Try the next one.
      }
    }
    await atomicState(home, state);
    return { status: "checked" };
  } catch (error) {
    if (state?.checkedAt) try { await atomicState(home, state); } catch {}
    return { status: "failed", error };
  } finally { await unlock(); }
}

export function launchCoreUpdateWorker(fallback, options = {}) {
  if (context(options).platform !== "win32" || !enabled(options)) return null;
  const worker = fileURLToPath(new URL("../bin/core-update-worker.mjs", import.meta.url));
  const args = [worker, path.resolve(fallback)];
  if (options.releaseId) args.push(options.releaseId);
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
  return child;
}
