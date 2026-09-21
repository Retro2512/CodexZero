import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { codexZeroHome } from "./paths.mjs";

const FILE_NAME = "provider-secrets.json";
const ID_PATTERN = /^[a-z0-9_]+$/;
const writes = new Map();
const ENCRYPT = String.raw`$ErrorActionPreference='Stop';$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);try{$sealed=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($sealed))}finally{[Array]::Clear($bytes,0,$bytes.Length)}`;
const DECRYPT = String.raw`$ErrorActionPreference='Stop';$text=[Console]::In.ReadToEnd();$sealed=[Convert]::FromBase64String($text);$bytes=[Security.Cryptography.ProtectedData]::Unprotect($sealed,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))}finally{[Array]::Clear($bytes,0,$bytes.Length);[Array]::Clear($sealed,0,$sealed.Length)}`;

export const providerKeyStorageSupported = process.platform === "win32";

function idOf(provider) {
  const id = typeof provider === "string" ? provider : provider?.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("Provider id is invalid");
  return id;
}

async function readDocument(home) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(home, FILE_NAME), "utf8"));
    if (!value || value.version !== 1 || !value.keys || typeof value.keys !== "object" || Array.isArray(value.keys)) throw new Error();
    const keys = {};
    for (const [id, ciphertext] of Object.entries(value.keys)) {
      if (!ID_PATTERN.test(id) || typeof ciphertext !== "string" || !ciphertext) throw new Error();
      keys[id] = ciphertext;
    }
    return keys;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error instanceof SyntaxError || !error.code) throw new Error("provider-secrets.json has an unsupported format");
    throw error;
  }
}

function powershell(script, input) {
  if (!providerKeyStorageSupported) throw new Error("Direct API key storage is unavailable on this platform");
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const executable = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    const setup = "Add-Type -AssemblyName System.Security;[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", setup + script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
    });
    const output = [];
    const errors = [];
    let outputSize = 0;
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize <= 64 * 1024) output.push(chunk);
      else child.kill();
    });
    child.stderr.on("data", (chunk) => { if (errors.reduce((n, item) => n + item.length, 0) < 4096) errors.push(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 && outputSize <= 64 * 1024) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error("Windows could not access the saved API key"));
    });
    child.stdin.end(input, "utf8");
  });
}

async function publish(keys, home) {
  await fs.mkdir(home, { recursive: true });
  const destination = path.join(home, FILE_NAME);
  const temporary = path.join(home, `.${FILE_NAME}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, keys }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600).catch((error) => { if (process.platform !== "win32") throw error; });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function hasProviderKey(provider, home = codexZeroHome()) {
  return Object.hasOwn(await readDocument(home), idOf(provider));
}

export async function getProviderKey(provider, home = codexZeroHome(), environment = process.env) {
  if (provider?.apiKeyEnv && environment[provider.apiKeyEnv]) return environment[provider.apiKeyEnv];
  if (!providerKeyStorageSupported) return "";
  const ciphertext = (await readDocument(home))[idOf(provider)];
  return ciphertext ? powershell(DECRYPT, ciphertext) : "";
}

export function updateProviderKeys({ keys = {}, clear = [], activeIds = [] }, home = codexZeroHome()) {
  const root = path.resolve(home);
  const previous = writes.get(root) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (!providerKeyStorageSupported && Object.keys(keys).length) throw new Error("Direct API key storage is unavailable on this platform");
    const document = await readDocument(root);
    const active = new Set(activeIds.map(idOf));
    for (const id of Object.keys(document)) if (!active.has(id)) delete document[id];
    for (const id of clear.map(idOf)) delete document[id];
    for (const [id, secret] of Object.entries(keys)) {
      idOf(id);
      if (!active.has(id)) throw new TypeError("API key provider is invalid");
      if (typeof secret !== "string" || !secret || secret.length > 16 * 1024) throw new TypeError("API key is invalid");
      document[id] = await powershell(ENCRYPT, secret);
    }
    await publish(document, root);
  });
  writes.set(root, current);
  current.finally(() => { if (writes.get(root) === current) writes.delete(root); }).catch(() => {});
  return current;
}
