import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import visibility from "../assets/native-sidebar-threads.cjs";

const stockCore = fileURLToPath(new URL("../work/core-update-20260930/runtime/codex.exe", import.meta.url));
const core = process.env.CODEXZERO_TEST_CORE || stockCore;
const enabled = process.env.CODEXZERO_RUN_RUNTIME_TESTS === "1" || Boolean(process.env.CODEXZERO_TEST_CORE);

function isolatedEnvironment(root, home, sqliteHome) {
  const environment = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PROCESSOR_ARCHITECTURE"]) {
    if (process.env[key] != null) environment[key] = process.env[key];
  }
  return { ...environment, HOME: root, USERPROFILE: root, APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"), TMP: root, TEMP: root,
    CODEX_HOME: home, CODEX_SQLITE_HOME: sqliteHome, CODEX_ZERO_SQLITE_HOME: sqliteHome,
    CODEX_ZERO_CORE_UPDATES: "0", RUST_LOG: "error" };
}

async function clientFor(home, environment) {
  const child = spawn(core, ["app-server"], { cwd: home, env: environment,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let sequence = 0;
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const lines = createInterface({ input: child.stdout });
  const fail = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on("error", fail);
  child.once("exit", code => fail(new Error(`Isolated app server exited: ${code}; ${stderr}`)));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(`${item.method}: ${JSON.stringify(message.error)}`));
    else item.resolve(message.result);
  });
  const client = {
    rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; ${stderr}`)); }, 15000);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    async close() {
      if (child.exitCode == null && child.signalCode == null) child.stdin.end();
      let timer;
      await Promise.race([exited, new Promise(resolve => {
        timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      })]);
      clearTimeout(timer);
      if (child.exitCode == null && child.signalCode == null) await exited;
      lines.close();
    },
  };
  try {
    await client.rpc("initialize", { clientInfo: { name: "thread_list_fixture", version: "1.0" },
      capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return client;
  } catch (error) { await client.close(); throw error; }
}

async function rollout(home, { timestamp, source = "vscode", provider = "openai" }) {
  const id = randomUUID();
  const directory = path.join(home, "sessions", timestamp.slice(0, 4), timestamp.slice(5, 7), timestamp.slice(8, 10));
  await fs.mkdir(directory, { recursive: true });
  const filename = `rollout-${timestamp.slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`;
  const file = path.join(directory, filename);
  const text = "Synthetic listing fixture";
  const lines = [
    { timestamp, type: "session_meta", payload: { id, session_id: id, timestamp, cwd: home,
      originator: "thread_list_fixture", cli_version: "0.0.0", source, model_provider: provider } },
    { timestamp, type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text }] } },
    { timestamp, type: "event_msg", payload: { type: "user_message", message: text, kind: "plain" } },
  ];
  await fs.writeFile(file, `${lines.map(value => JSON.stringify(value)).join("\n")}\n`);
  await fs.utimes(file, new Date(timestamp), new Date(timestamp));
  return id;
}

async function stateDatabase(directory, DatabaseSync) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const filename = path.join(directory, entry.name);
    const handle = await fs.open(filename, "r");
    let header;
    try { header = Buffer.alloc(16); await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    if (header.toString("binary") !== "SQLite format 3\0") continue;
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'backfill_state'").get()) return filename;
    } finally { database.close(); }
  }
  throw new Error("Isolated core did not create its state database");
}

test("actual core listing repairs completed backfill omissions and retains repaired threads after restart", {
  skip: enabled ? false : "Set CODEXZERO_RUN_RUNTIME_TESTS=1 or CODEXZERO_TEST_CORE to run the isolated core probe",
  timeout: 90000,
}, async t => {
  try { await fs.access(core); } catch { t.skip(`Core executable not found: ${core}`); return; }
  const { DatabaseSync } = await import("node:sqlite");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-thread-list-runtime-"));
  const home = path.join(root, "home"), sqliteHome = path.join(root, "sqlite");
  let client;
  t.after(async () => {
    try { await client?.close(); } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith("cz-thread-list-runtime-"));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  await Promise.all([fs.mkdir(home), fs.mkdir(sqliteHome)]);
  await fs.writeFile(path.join(home, "config.toml"), '[analytics]\nenabled = false\n[skills.bundled]\nenabled = false\n[features]\nplugins = false\n');
  const environment = isolatedEnvironment(root, home, sqliteHome);
  const seed = await rollout(home, { timestamp: "2025-01-01T10:00:00Z", source: "cli" });
  client = await clientFor(home, environment);
  const list = overrides => client.rpc("thread/list", { archived: false, limit: 100,
    modelProviders: [], sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true, ...overrides });
  const ids = result => result.data.map(thread => thread.id);
  assert.deepEqual(ids(await list()), [seed]);
  const databasePath = await stateDatabase(sqliteHome, DatabaseSync);
  const read = query => {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try { return database.prepare(query).all(); } finally { database.close(); }
  };
  assert.equal(read("SELECT status FROM backfill_state WHERE id = 1")[0].status, "complete");

  const native = await rollout(home, { timestamp: "2025-01-02T10:00:00Z" });
  const atlas = await rollout(home, { timestamp: "2025-01-03T10:00:00Z", source: { custom: "atlas" }, provider: "codexzero_custom" });
  const appServer = await rollout(home, { timestamp: "2025-01-04T10:00:00Z", source: "mcp" });
  const alternate = await rollout(home, { timestamp: "2025-01-05T10:00:00Z", source: "cli", provider: "fixture_provider" });
  assert.deepEqual(ids(await list()), [seed], "DB only must not silently repair new rollout files");
  await client.close(); client = await clientFor(home, environment);
  assert.deepEqual(ids(await list()), [seed], "Completed startup backfill must not be mistaken for reconciliation");

  const catalogList = visibility.createListing((params, _options) => client.rpc("thread/list", params), "local", []);
  const catalogRows = []; let catalogCursor = null;
  do {
    const page = await catalogList({ cursor: catalogCursor, limit: 2 });
    catalogRows.push(...page.data); catalogCursor = page.nextCursor;
  } while (catalogCursor);
  assert.deepEqual(new Set(catalogRows.map(thread => thread.id)), new Set([seed, native, atlas, appServer, alternate]), "Catalog recovery must include app server and custom chat tasks without dropping database history");
  assert.equal(catalogRows.length, 5, "Independent recovery cursors must not produce duplicates");

  const recovered = await list({ useStateDbOnly: false });
  assert.deepEqual(new Set(ids(recovered)), new Set([seed, native, atlas, alternate]));
  assert.ok(!ids(recovered).includes(appServer), "Default interactive sources exclude app server tasks");
  assert.deepEqual(ids(await list({ sourceKinds: ["appServer"], useStateDbOnly: false })), [appServer]);
  assert.deepEqual(ids(await list({ sourceKinds: ["vscode"] })), [native]);
  assert.deepEqual(new Set(ids(await list({ sourceKinds: [] }))), new Set([seed, native, atlas, alternate]));
  assert.deepEqual(new Set(ids(await list({ modelProviders: ["openai"] }))), new Set([seed, native]));
  t.diagnostic(`Recovered ${recovered.data.length} interactive fixtures; appServer requires explicit source filter; modelProviders=[] includes both fixture providers`);

  // Exercise the actual negotiated project API, not just membership mocks.
  const project = (await client.rpc("project/create", { idempotencyKey: randomUUID(), name: "Fixture project", roots: [{ path: home }] })).project;
  assert.ok((await client.rpc("project/list", { cursor: null, limit: 100 })).data.some(item => item.id === project.id));
  await client.rpc("thread/metadata/update", { threadId: appServer, projectId: project.id });
  assert.equal((await client.rpc("thread/read", { threadId: appServer, includeTurns: false })).thread.projectId, project.id);

  await client.close(); client = null;
  const columns = new Set(read("PRAGMA table_info(threads)").map(column => column.name));
  assert.ok(columns.has("recency_at"), "Core state schema must expose independent task recency");
  const database = new DatabaseSync(databasePath);
  try {
    const milliseconds = Date.parse("2025-02-01T10:00:00Z");
    const fields = columns.has("recency_at_ms") ? "recency_at = ?, recency_at_ms = ?" : "recency_at = ?";
    const values = columns.has("recency_at_ms") ? [milliseconds / 1000, milliseconds, seed] : [milliseconds / 1000, seed];
    database.prepare(`UPDATE threads SET ${fields} WHERE id = ?`).run(...values);
  } finally { database.close(); }
  client = await clientFor(home, environment);
  assert.deepEqual(new Set(ids(await list())), new Set([seed, native, atlas, alternate]), "Repaired rows must survive restart");
  assert.deepEqual(ids(await list({ sourceKinds: ["appServer"] })), [appServer]);
  assert.equal((await list({ sourceKinds: ["appServer"] })).data[0].projectId, project.id, "Mobile project membership must survive restart and catalog listing");
  const recent = await list({ sortKey: "recency_at" });
  assert.equal(recent.data[0].id, seed, "Recency order must differ from output update order");
  assert.ok(ids(await list()).indexOf(seed) > ids(await list()).indexOf(native));
  t.diagnostic(`recencyAt field: ${Object.hasOwn(recent.data[0], "recencyAt") ? JSON.stringify(recent.data[0].recencyAt) : "absent"}; updated_at and recency_at return different ordering`);
});
