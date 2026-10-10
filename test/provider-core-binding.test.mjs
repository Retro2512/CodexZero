import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { CORE_BINDING_NAME, resolveProviderCore, writeProviderCoreBinding } from "../src/provider-core-binding.mjs";
import { prepareProviderLauncher } from "../src/provider-launcher.mjs";
import { providerLauncherScript } from "../src/desktop-macos.mjs";
import { verifyProviderHelper } from "../scripts/verify-provider-helper.mjs";

const run = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "..");

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-core-binding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test("installed core binding preserves explicit settings and fails closed without discovery", async t => {
  const root = await temporary(t), directory = path.join(root, "provider-runtime");
  const core = path.join(directory, "selected/core.exe");
  await fs.mkdir(path.dirname(core), { recursive: true });
  await fs.writeFile(core, "core");
  const binding = await writeProviderCoreBinding(directory, core);
  const options = { environment: {}, installationRoot: root };
  assert.equal(await resolveProviderCore(options), core);
  assert.equal(await resolveProviderCore({ ...options, environment: { CODEX_ZERO_PROVIDER_CORE: "explicit" } }), "explicit");
  for (const value of [{}, { schema: 2, core: "selected/core.exe" }, { schema: 1, core }, { schema: 1, core: "" }, { schema: 1, core: "bad\0path" }]) {
    await fs.writeFile(binding, JSON.stringify(value));
    await assert.rejects(resolveProviderCore(options), /binding is invalid/);
  }
  await fs.writeFile(binding, "{");
  await assert.rejects(resolveProviderCore(options), /binding is missing or unreadable/);
  await fs.writeFile(binding, " ".repeat(32769));
  await assert.rejects(resolveProviderCore(options), /binding is missing or unreadable/);
  await writeProviderCoreBinding(directory, path.join(directory, "missing.exe"));
  await assert.rejects(resolveProviderCore(options), /ENOENT/);
  await fs.rm(binding);
  await assert.rejects(resolveProviderCore(options), /binding is missing or unreadable/);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["selected"]);
});

test("relative installation binding survives spaces, relocation and replacement builds", async t => {
  const root = await temporary(t), build = path.join(root, "build");
  const directory = path.join(build, "provider-runtime"), core = path.join(directory, "version 1/core.exe");
  await fs.mkdir(path.dirname(core), { recursive: true });
  await fs.writeFile(core, "version one");
  const binding = await writeProviderCoreBinding(directory, core);
  assert.equal(JSON.parse(await fs.readFile(binding)).core, path.relative(directory, core));
  const installed = path.join(root, "Installed app with spaces");
  await fs.rename(build, installed);
  const relocated = path.join(installed, "provider-runtime/version 1/core.exe");
  assert.equal(await resolveProviderCore({ environment: {}, installationRoot: installed }), relocated);
  const next = path.join(installed, "provider-runtime/version 2/core.exe");
  await fs.mkdir(path.dirname(next), { recursive: true });
  await fs.writeFile(next, "version two");
  await writeProviderCoreBinding(path.dirname(path.dirname(next)), next);
  assert.equal(await resolveProviderCore({ environment: {}, installationRoot: installed }), next);
});

async function fixture(t) {
  const root = await temporary(t), build = path.join(root, "build");
  for (const directory of ["bin", "src", "runtime", "provider-runtime/version 1"]) await fs.mkdir(path.join(build, directory), { recursive: true });
  await fs.writeFile(path.join(build, "package.json"), '{"type":"module"}');
  for (const file of ["bin/provider-core.mjs", "src/provider-core-binding.mjs"]) await fs.copyFile(path.join(repository, file), path.join(build, file));
  await fs.writeFile(path.join(build, "src/core-updates.mjs"), 'export const selectUpdatedCore = core => core; export const launchCoreUpdateWorker = () => {}; export const isPackagedPatchedCore = () => false;');
  await fs.writeFile(path.join(build, "src/provider-app-server.mjs"), `import { createInterface } from 'node:readline';
export async function runProviderAppServer({core,input=process.stdin,output=process.stdout}) {
 for await (const line of createInterface({input})) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') output.write(JSON.stringify({id:message.id,result:{core,client:message.params.clientInfo.name}})+'\\n');
 }
 return 0;
}`);
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await fs.copyFile(process.execPath, path.join(build, "runtime", nodeName));
  const core = path.join(build, "provider-runtime/version 1", nodeName);
  await fs.copyFile(process.execPath, core);
  if (process.platform !== "win32") { await fs.chmod(core, 0o755); await fs.chmod(path.join(build, "runtime", nodeName), 0o755); }
  return { root, build, core, nodeName };
}

test("real provider entry initializes without inherited provider settings after relocation and upgrade", async t => {
  const { root, build, core, nodeName } = await fixture(t);
  const previous = process.env.CODEX_ZERO_PROVIDER_CORE;
  process.env.CODEX_ZERO_PROVIDER_CORE = core;
  try {
    if (process.platform === "win32") await prepareProviderLauncher("unused", { home: build });
    else {
      await writeProviderCoreBinding(path.join(build, "provider-runtime"), core);
      await fs.writeFile(path.join(build, "provider-runtime/codex-custom-models"), providerLauncherScript(), { mode: 0o755 });
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_ZERO_PROVIDER_CORE;
    else process.env.CODEX_ZERO_PROVIDER_CORE = previous;
  }
  const installed = path.join(root, "Installed app with spaces");
  await fs.rename(build, installed);
  const launcher = path.join(installed, "provider-runtime", process.platform === "win32" ? "codex-custom-models.exe" : "codex-custom-models");
  const first = await verifyProviderHelper(launcher);
  assert.equal(first.core, path.join(installed, "provider-runtime/version 1", nodeName));
  assert.equal(first.client, "codex-browser-use");
  const next = path.join(installed, "provider-runtime/version 2", nodeName);
  await fs.mkdir(path.dirname(next), { recursive: true });
  await fs.copyFile(path.join(installed, "runtime", nodeName), next);
  if (process.platform !== "win32") await fs.chmod(next, 0o755);
  await writeProviderCoreBinding(path.join(installed, "provider-runtime"), next);
  assert.equal((await verifyProviderHelper(launcher)).core, next);
  const binding = path.join(installed, "provider-runtime", CORE_BINDING_NAME);
  await fs.rm(binding);
  await assert.rejects(verifyProviderHelper(launcher), /binding is missing or unreadable/);
  await writeProviderCoreBinding(path.dirname(binding), next);
  const env = { ...process.env, CODEX_ZERO_CORE_BINDING: "stale binding", CODEX_ZERO_PROVIDER_CORE: next };
  const { stdout } = await run(launcher, ["--version"], { env, windowsHide: true });
  assert.match(stdout, /^v\d+/);
});

test("development launcher supplies its own exact binding without inherited core settings", { skip: process.platform !== "win32" }, async t => {
  const root = await temporary(t), core = path.join(root, "selected node.exe");
  await fs.copyFile(process.execPath, core);
  const previous = process.env.CODEX_ZERO_PROVIDER_CORE;
  process.env.CODEX_ZERO_PROVIDER_CORE = core;
  let launcher;
  try { ({ launcher } = await prepareProviderLauncher("unused", { home: root })); }
  finally {
    if (previous === undefined) delete process.env.CODEX_ZERO_PROVIDER_CORE;
    else process.env.CODEX_ZERO_PROVIDER_CORE = previous;
  }
  const environment = { ...process.env, CODEX_ZERO_CORE_BINDING: "stale binding" };
  delete environment.CODEX_ZERO_PROVIDER_CORE;
  const { stdout } = await run(launcher, ["--version"], { env: environment, windowsHide: true });
  assert.equal(stdout.trim(), process.version);
});

test("an explicit build core cannot be replaced by a stale inherited development override", async t => {
  const root = await temporary(t), sourceCore = path.join(root, "dist/codex-zero-core.exe");
  await fs.mkdir(path.dirname(sourceCore), { recursive: true });
  await fs.writeFile(sourceCore, "selected package core");
  const previous = process.env.CODEX_ZERO_PROVIDER_CORE;
  process.env.CODEX_ZERO_PROVIDER_CORE = path.join(root, "stale core.exe");
  try {
    const {core} = await prepareProviderLauncher("unused", {home:path.join(root,"build"),sourceCore});
    assert.equal(await fs.readFile(core, "utf8"), "selected package core");
    assert.equal(await resolveProviderCore({environment:{},installationRoot:path.join(root,"build")}), core);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ZERO_PROVIDER_CORE;
    else process.env.CODEX_ZERO_PROVIDER_CORE = previous;
  }
});
