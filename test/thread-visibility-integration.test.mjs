import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { openAsar } from "../src/asar-patch.mjs";
import { patchThreadVisibilityMain, patchThreadVisibilityRenderer } from "../src/thread-visibility-patch.mjs";
import visibility from "../assets/native-sidebar-threads.cjs";

const archivePath = process.env.CODEXZERO_TEST_ASAR || "work/local-providers/20260921-reasoning-picker/desktop/resources/app.asar";
const bundled = { skip: !fs.existsSync(archivePath) };
const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));
const sqliteBundled = { skip: bundled.skip || (!DatabaseSync && "Node SQLite is unavailable") };

async function bundles() {
  const archive = await openAsar(archivePath);
  try {
    const main = Object.keys(archive.header.files[".vite"].files.build.files).find(name => /^main-.*\.js$/.test(name));
    const renderer = Object.keys(archive.header.files.webview.files.assets.files).find(name => /^app-initial-.*\.js$/.test(name));
    return { main: (await archive.read(`.vite/build/${main}`)).toString(), renderer: (await archive.read(`webview/assets/${renderer}`)).toString() };
  } finally { await archive.close(); }
}

function fragment(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing bundled fragment: ${start}`);
  return source.slice(a, b);
}

function catalogDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, source_created_at REAL, source_updated_at REAL, source_recency_at REAL, cwd TEXT, source_kind TEXT, source_detail TEXT, thread_source TEXT, model_provider TEXT, git_branch TEXT, project_id TEXT, conversation_origin TEXT, observation_sequence INTEGER, pending_observed_title INTEGER DEFAULT 0, missing_candidate INTEGER DEFAULT 0, PRIMARY KEY(host_id, thread_id));
    CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, watermark_updated_at REAL, initial_build_complete INTEGER DEFAULT 0, last_full_reconciled_at REAL, observation_sequence INTEGER DEFAULT 0);
    CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT);
    CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER DEFAULT 0);
    INSERT INTO local_thread_catalog_metadata VALUES (1,0);
    CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER DEFAULT 0, PRIMARY KEY(host_id,thread_id));
    CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT PRIMARY KEY, checkpoint TEXT, failed_at REAL);`);
  return db;
}

function storeClass(source) {
  const code = fragment(source, "var Dme=class{", "var Wh=");
  const sql = fragment(source, "Eme=`", ";function zh(").slice(4);
  const schema = { safeParse: data => ({ success: true, data }) };
  return new Function("czThreadVisibility", "Lh", "Eme", "Cme", "wme", "Tme", "Bh", `${code};return Dme;`)(visibility, "local", new Function(`return ${sql}`)(), schema, schema, {}, ({ threadId }) => threadId);
}

function entry(id, cwd, updatedAt, recencyAt = updatedAt) {
  return { hostId: "local", threadId: id, displayTitle: id, cwd, sourceKind: "cli", sourceDetail: null, threadSource: null, modelProvider: "openai", gitBranch: null, sourceCreatedAt: 1, sourceUpdatedAt: updatedAt, sourceRecencyAt: recencyAt };
}

test("real patched catalog queries preserve assignment inclusion, aliases, exclusions and page boundaries", sqliteBundled, async () => {
  const { main } = await bundles();
  const patched = patchThreadVisibilityMain(main);
  assert.throws(() => patchThreadVisibilityMain(patched));
  assert.throws(() => patchThreadVisibilityMain("changed upstream"));
  const Store = storeClass(patched), db = catalogDatabase();
  try {
    const store = new Store(db);
    for (const row of [entry("a", "C:\\Work\\Repo", 6), entry("b", "c:/work/repo/sub", 5), entry("near", "c:/work/repository", 4), entry("assigned", null, 3), entry("excluded", "C:/work/repo", 2)]) store.applyObservedEntry(row);
    const filter = { cwdValues: ["c:/work/repo/"], cwdPrefixes: ["C:\\Work\\Repo\\", "/mnt/c/work/repo/sub/"], includeThreadIds: ["assigned"], excludeThreadIds: ["excluded"] };
    let cursor = null, rows = [];
    do { const page = store.readPage({ limit: 1, cursor, filter, sortKey: "updated_at" }); rows.push(...page.entries); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(rows.map(row => row.threadId), ["a", "b", "assigned"]);
    assert.equal(rows[0].cwd, "C:\\Work\\Repo");
    assert.deepEqual(store.readPage({ limit: 10, filter, manualOrder: { threadIds: ["assigned", "excluded", "b", "a"], startIndex: 0 }, sortKey: "updated_at" }).entries.map(row => row.threadId), ["assigned", "b", "a"]);
    assert.deepEqual(store.readPage({ limit: 10, filter, sortKey: "created_at" }).entries.map(row => row.threadId), ["a", "b", "assigned"]);
  } finally { db.close(); }
});

function coordinatorClass(source) {
  const code = fragment(source, "Rtt=class{", ";function ztt(");
  const context = { czThreadVisibility: visibility, n: { ar: params => params?.threadId, ir: params => params?.thread },
    Mtt: 30_000, O5: 10_000, Ntt: 250, Ptt: 1000, Ftt: 8, Itt: 3_600_000, Ltt: 60_000, D5: 100,
    k5: items => new Map(items.map(item => [item.id, item.updatedAt])), ztt: items => items.length ? Math.max(...items.map(item => item.updatedAt)) : null,
    zh: thread => thread.ephemeral ? null : entry(thread.id, thread.cwd, thread.updatedAt, thread.recencyAt) };
  return new Function(...Object.keys(context), `let ${code};return Rtt;`)(...Object.values(context));
}

test("real coordinator startup revalidates completed history and Activity updates the project catalog", sqliteBundled, async () => {
  const { main } = await bundles(), patched = patchThreadVisibilityMain(main);
  const Store = storeClass(patched), Coordinator = coordinatorClass(patched), db = catalogDatabase();
  const store = new Store(db);
  let now = 1000, coordinator;
  try {
    const firstScan = store.beginScan("full"); store.applyScanPage(firstScan, [entry("existing", "C:/repo", 1)]); store.completeScan(firstScan, 1, now);
    const modes = [], updates = [];
    const listing = visibility.createListing(async ({ useStateDbOnly }) => ({ data: useStateDbOnly ? [{ id: "existing", cwd: "C:/repo", updatedAt: 1, recencyAt: 1 }] : [{ id: "mobile", cwd: "C:\\Repo", updatedAt: 2, recencyAt: 2 }], nextCursor: null }), "local", ["cli"]);
    coordinator = new Coordinator({ listPage: async params => { const page = await listing(params); return { items: page.data.map(thread => ({ id: thread.id, updatedAt: thread.updatedAt, entry: entry(thread.id, thread.cwd, thread.updatedAt, thread.recencyAt) })), nextCursor: page.nextCursor }; },
      readItem: async id => ({ entry: entry(id, "C:/repo", 20, 19) }) }, store, { now: () => now, scheduleRun: async (mode, _, run) => { modes.push(mode); return run(); } });
    coordinator.subscribe(update => updates.push(update));
    assert.equal(await coordinator.requestStartupSync(), "completed");
    assert.deepEqual(modes, ["full"]);
    assert.ok(store.readEntry("existing"), "database task must survive filesystem recovery");
    assert.ok(store.readEntry("mobile"), "mobile task must enter catalog after restart");
    now = 301_000; coordinator.lastSuccessAt = now;
    assert.equal(await coordinator.requestSync(), "completed");
    assert.deepEqual(modes, ["full", "full"], "Frequent incremental successes must not indefinitely postpone reconciliation");
    coordinator.handleNotification({ method: "turn/started", params: { threadId: "existing" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.readEntry("existing").sourceRecencyAt, 19);
    assert.equal(store.readPage({ limit: 10, sortKey: "updated_at" }).entries[0].threadId, "existing");
    assert.ok(updates.some(update => update.type === "delta" && update.entries.some(row => row.threadId === "existing")));
    coordinator.setSyncEnabled(false);
    coordinator.handleNotification({ method: "thread/started", params: { thread: { id: "offscreen", cwd: "C:/repo", updatedAt: 30, recencyAt: 30 } } });
    assert.ok(store.readEntry("offscreen"), "offscreen creation must persist while population is disabled");
    coordinator.dispose(); assert.equal(coordinator.czCatalogPoll, null);
  } finally { coordinator?.dispose(); db.close(); }
});

test("both bundled live stores refresh sort fields and their fallbacks never freeze recency", bundled, async () => {
  const { main, renderer } = await bundles();
  for (const [source, patch, summaryToken, metadataToken, equalityToken, sortToken] of [
    [main, patchThreadVisibilityMain, "ky", "jy", "W", "Xge"],
    [renderer, patchThreadVisibilityRenderer, "sh", "lh", "uh", "EBt"],
  ]) {
    const patched = patch(source);
    const method = fragment(patched, "observeCatalogThreads(e){", "getCachedThreadMetadata(");
    const live = { id: "task", updatedAt: 1000, recencyAt: 1000, cwd: "old", title: "Task", resumeState: "needs_resume" };
    const context = { czThreadVisibility: visibility, czObserveThread: visibility.applyObservation, czObservedActivity: visibility.observedActivity, n: { Iu: id => id }, ti: id => id,
      [summaryToken]: thread => ({ updatedAt: thread.updatedAt * 1000 }), [metadataToken]: () => ({}), [equalityToken]: { default: isDeepStrictEqual }, [sortToken]: () => 0 };
    const instance = new Function(...Object.keys(context), `return ({${method}});`)(...Object.values(context));
    Object.assign(instance, { threadSummaries: [], conversations: new Map([["task", live]]), threadsById: new Map(), pendingThreadTitlesById: new Map(), confirmedThreadTitlesById: new Map(), getCachedDisplayThreadTitle: name => name, applyPendingThreadTitle: row => row, takeRuntimeStatusEvidence: row => row,
      updateConversationState: (_, update) => update(live), getThreadSummaryFromThread: row => ({ conversationId: row.id }), shouldSurfaceThreadSummary: () => true, replaceRecentThreadSummaries: () => {} });
    instance.observeCatalogThreads([{ id: "task", updatedAt: 20, recencyAt: 19, cwd: "new", name: "Task" }]);
    assert.equal(live.updatedAt, 20_000); assert.equal(live.recencyAt, 19_000); assert.equal(live.cwd, "new");
    instance.confirmedThreadTitlesById.set("task", "Task");
    instance.observeCatalogThreads([{ id: "task", updatedAt: 20, recencyAt: 25, cwd: "changed", name: "Task" }]);
    assert.equal(live.recencyAt, 25_000, "same timestamp title reconciliation must not discard independently updated recency");
    assert.equal(instance.threadsById.get("task").recencyAt, 25);
    assert.equal(live.cwd, "changed");
    instance.observeCatalogThreads([{ id: "task", updatedAt: 10, recencyAt: 9, cwd: "stale", name: "Task" }]);
    assert.equal(live.recencyAt, 25_000); assert.equal(live.cwd, "changed");
    const fallbackName = source === main ? "Ay" : "ch";
    const fallbackStart = patched.indexOf(`function ${fallbackName}(`);
    const fallbackEnd = patched.indexOf("}", patched.indexOf("){", fallbackStart)) + 1;
    assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);
    const recency = new Function(`${patched.slice(fallbackStart, fallbackEnd)};return ${fallbackName};`)();
    assert.equal(recency({ currentRecencyAt: 5, threadRecencyAt: null, updatedAt: 10 }), 10);
    assert.equal(recency({ currentRecencyAt: 20, threadRecencyAt: 10, updatedAt: 30 }), 20, "metadata updatedAt must not displace explicit recency");
  }
});
