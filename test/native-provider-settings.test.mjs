import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { openAsar, rewriteAsar } from "../src/asar-patch.mjs";
import { readProviderSettings, saveProviderSettings } from "../src/provider-config-service.mjs";
import { hasProviderKey, providerKeyStorageSupported } from "../src/provider-secrets.mjs";

async function temporary(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function provider(overrides = {}) {
  return {
    id: "local_model",
    name: "Local model",
    apiType: "responses",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "exact-model-id",
    apiKeyEnv: "",
    maxOutputTokens: 4096,
    enabled: true,
    ...overrides,
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function integrity(bytes) {
  return {
    algorithm: "SHA256",
    hash: sha256(bytes),
    blockSize: 4 * 1024 * 1024,
    blocks: [sha256(bytes)],
  };
}

async function writeAsarFixture(file) {
  const original = Buffer.from("original packed asset");
  const replace = Buffer.from("old replacement asset");
  const unpacked = Buffer.from("unpacked native asset");
  const header = {
    files: {
      app: {
        files: {
          "original.txt": { size: original.length, offset: "0", integrity: integrity(original) },
          "replace.txt": { size: replace.length, offset: String(original.length), integrity: integrity(replace) },
          "native.node": { size: unpacked.length, unpacked: true, integrity: integrity(unpacked) },
        },
      },
    },
  };
  const json = Buffer.from(JSON.stringify(header));
  const padding = (4 - json.length % 4) % 4;
  const headerSize = 8 + json.length + padding;
  const pickle = Buffer.alloc(8 + headerSize);
  pickle.writeUInt32LE(4, 0);
  pickle.writeUInt32LE(headerSize, 4);
  pickle.writeUInt32LE(headerSize - 4, 8);
  pickle.writeUInt32LE(json.length, 12);
  json.copy(pickle, 16);
  await fs.writeFile(file, Buffer.concat([pickle, original, replace]));

  const unpackedFile = path.join(`${file}.unpacked`, "app", "native.node");
  await fs.mkdir(path.dirname(unpackedFile), { recursive: true });
  await fs.writeFile(unpackedFile, unpacked);
  return { original, replace, unpacked, header };
}

test("native provider service saves and reads validated settings without leaking keys", async (t) => {
  const home = await temporary(t, "codexzero-native-provider-");
  const variable = `CODEXZERO_NATIVE_KEY_${Date.now()}`;
  const secret = `environment-secret-${Date.now()}`;
  const configured = provider({ apiKeyEnv: variable });

  const saved = await saveProviderSettings({ providers: [configured], keys: {}, clearKeys: [] }, home);
  assert.equal(saved.providers[0].id, configured.id);
  assert.equal(saved.providers[0].apiKeyPresent, false);
  assert.equal(saved.providers[0].directKeyPresent, false);

  const read = await readProviderSettings(home, { [variable]: secret });
  assert.equal(read.providers[0].apiKeyPresent, true);
  assert.equal(read.providers[0].directKeyPresent, false);
  assert.equal(read.directKeySupported, providerKeyStorageSupported);
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(read), new RegExp(secret));
  assert.doesNotMatch(await fs.readFile(path.join(home, "providers.json"), "utf8"), new RegExp(secret));
});

test("native provider service rejects invalid settings documents", async (t) => {
  const home = await temporary(t, "codexzero-native-invalid-");
  await assert.rejects(
    saveProviderSettings({ providers: [provider()], keys: {}, clearKeys: [], extra: true }, home),
    /Invalid provider settings/,
  );
  await assert.rejects(
    saveProviderSettings({ providers: [{ ...provider(), apiKey: "plaintext" }], keys: {}, clearKeys: [] }, home),
    /unsupported field/,
  );
  await assert.rejects(
    saveProviderSettings({ providers: [provider()], keys: { missing_provider: "secret" }, clearKeys: [] }, home),
    /Invalid API key provider/,
  );
  await assert.rejects(fs.access(path.join(home, "providers.json")));
});

test("deleting a provider clears its saved DPAPI key without exposing plaintext", { skip: !providerKeyStorageSupported }, async (t) => {
  const home = await temporary(t, "codexzero-native-dpapi-");
  const secret = `direct-secret-${Date.now()}`;
  const configured = provider();

  const created = await saveProviderSettings({
    providers: [configured],
    keys: { [configured.id]: secret },
    clearKeys: [],
  }, home);
  assert.equal(created.providers[0].directKeyPresent, true);
  assert.doesNotMatch(JSON.stringify(created), new RegExp(secret));
  assert.doesNotMatch(await fs.readFile(path.join(home, "provider-secrets.json"), "utf8"), new RegExp(secret));

  const removed = await saveProviderSettings({ providers: [], keys: {}, clearKeys: [configured.id] }, home);
  assert.deepEqual(removed.providers, []);
  assert.equal(await hasProviderKey(configured.id, home), false);
  const secrets = JSON.parse(await fs.readFile(path.join(home, "provider-secrets.json"), "utf8"));
  assert.deepEqual(secrets.keys, {});
});

test("native provider IPC rejects foreign origins and subframes", async () => {
  const handlers = new Map();
  const electron = {
    app: { setPath() {} },
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
  };
  const source = await fs.readFile(new URL("../assets/native-provider-main.cjs", import.meta.url), "utf8");
  const sandbox = {
    URL,
    process: { resourcesPath: path.resolve("resources"), env: {} },
    require(specifier) {
      if (specifier === "electron") return electron;
      if (specifier === "node:path") return path;
      if (specifier === "node:url") return { pathToFileURL: (awaitImportPath) => new URL(`file:///${String(awaitImportPath).replaceAll("\\", "/")}`) };
      throw new Error(`Unexpected require: ${specifier}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: "native-provider-main.cjs" });
  const read = handlers.get("codexzero:providers:read");
  const save = handlers.get("codexzero:providers:save");
  assert.equal(typeof read, "function");
  assert.equal(typeof save, "function");

  const foreignFrame = { url: "https://attacker.example/settings" };
  await assert.rejects(read({ senderFrame: foreignFrame, sender: { mainFrame: foreignFrame } }), /unavailable here/);

  const mainFrame = { url: "app://-/settings" };
  const childFrame = { url: "app://-/settings" };
  await assert.rejects(
    save({ senderFrame: childFrame, sender: { mainFrame } }, { providers: [] }),
    /unavailable here/,
  );
  for (const operation of ["read", "settings", "enabled", "activity"]) {
    const handler = handlers.get(`codexzero:cache:${operation}`);
    assert.equal(typeof handler, "function");
    await assert.rejects(handler({ senderFrame: foreignFrame, sender: { mainFrame: foreignFrame } }, "task"), /unavailable here/);
    await assert.rejects(handler({ senderFrame: childFrame, sender: { mainFrame } }, "task"), /unavailable here/);
    await assert.rejects(handler({ senderFrame: mainFrame, sender: { mainFrame } }, "task", true, "arbitrary directory"), /Invalid cache settings/);
  }
});

test("native provider preload exposes the bridge only to the app origin", async () => {
  const source = await fs.readFile(new URL("../assets/native-provider-preload.cjs", import.meta.url), "utf8");

  function execute(location) {
    const exposed = [];
    const invocations = [];
    const electron = {
      contextBridge: { exposeInMainWorld(name, value) { exposed.push({ name, value }); } },
      ipcRenderer: { invoke(...args) { invocations.push(args); return Promise.resolve({}); } },
    };
    vm.runInNewContext(source, {
      location,
      require(specifier) {
        if (specifier === "electron") return electron;
        throw new Error(`Unexpected require: ${specifier}`);
      },
    }, { filename: "native-provider-preload.cjs" });
    return { exposed, invocations };
  }

  assert.equal(execute({ protocol: "https:", hostname: "attacker.example" }).exposed.length, 0);
  assert.equal(execute({ protocol: "app:", hostname: "other" }).exposed.length, 0);
  const trusted = execute({ protocol: "app:", hostname: "-" });
  assert.equal(trusted.exposed.length, 2);
  assert.equal(trusted.exposed[0].name, "codexZeroProviders");
  await trusted.exposed[0].value.read();
  await trusted.exposed[0].value.save({ providers: [] });
  assert.equal(trusted.exposed[1].name, "codexZeroCache");
  await trusted.exposed[1].value.read("task");
  await trusted.exposed[1].value.saveSettings({ enabled: true, minutes: 30 });
  await trusted.exposed[1].value.setEnabled("task", false);
  await trusted.exposed[1].value.activity("task");
  assert.deepEqual(trusted.invocations.map((entry) => entry[0]), [
    "codexzero:providers:read",
    "codexzero:providers:save",
    "codexzero:cache:read",
    "codexzero:cache:settings",
    "codexzero:cache:enabled",
    "codexzero:cache:activity",
  ]);
});

test("ASAR rewrite preserves originals and unpacked entries while replacing and adding assets", async (t) => {
  const directory = await temporary(t, "codexzero-asar-");
  const source = path.join(directory, "app.asar");
  const destination = path.join(directory, "app.patched.asar");
  const fixture = await writeAsarFixture(source);
  const sourceBefore = await fs.readFile(source);
  const unpackedFile = path.join(`${source}.unpacked`, "app", "native.node");
  const replacement = Buffer.from("new replacement asset");
  const added = Buffer.from("newly added asset");

  await rewriteAsar(source, destination, new Map([
    ["app/replace.txt", replacement],
    ["app/new.txt", added],
  ]));

  assert.deepEqual(await fs.readFile(source), sourceBefore);
  assert.deepEqual(await fs.readFile(unpackedFile), fixture.unpacked);
  const archive = await openAsar(destination);
  try {
    assert.deepEqual(await archive.read("app/original.txt"), fixture.original);
    assert.deepEqual(await archive.read("app/replace.txt"), replacement);
    assert.deepEqual(await archive.read("app/new.txt"), added);
    assert.equal(archive.entry("app/native.node").unpacked, true);
    assert.deepEqual(archive.entry("app/original.txt").integrity, fixture.header.files.app.files["original.txt"].integrity);
    assert.deepEqual(archive.entry("app/replace.txt").integrity, integrity(replacement));
    assert.deepEqual(archive.entry("app/new.txt").integrity, integrity(added));
    await assert.rejects(archive.read("app/native.node"), /Missing packed app asset/);
  } finally {
    await archive.close();
  }
});
