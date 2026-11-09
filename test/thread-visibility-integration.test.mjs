import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { patchThreadVisibilityMain, patchThreadVisibilityRenderer, THREAD_VISIBILITY_MAIN_TARGET, THREAD_VISIBILITY_RENDERER_TARGET } from "../src/thread-visibility-patch.mjs";
import visibility from "../assets/native-sidebar-threads.cjs";
import { bundledAvailable, bundledSources, blockEnd, definition, evaluate } from "./bundled-source.mjs";

const bundled = { skip: !bundledAvailable && "Unpacked desktop bundle unavailable" };
const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));
const sqliteBundled = { skip: bundled.skip || (!DatabaseSync && "Node SQLite is unavailable") };
const bundles = () => bundledSources({ main: THREAD_VISIBILITY_MAIN_TARGET, renderer: THREAD_VISIBILITY_RENDERER_TARGET });
const schema = { safeParse: data => ({ success: true, data }), parse: data => data };

function catalogDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, source_created_at REAL, source_updated_at REAL, source_recency_at REAL, cwd TEXT, source_kind TEXT, source_detail TEXT, thread_source TEXT, model_provider TEXT, git_branch TEXT, project_id TEXT, conversation_origin TEXT, trial_conversation_type TEXT, chatgpt_async_status TEXT, observation_sequence INTEGER, pending_observed_title INTEGER DEFAULT 0, missing_candidate INTEGER DEFAULT 0, PRIMARY KEY(host_id, thread_id));
    CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, watermark_updated_at REAL, initial_build_complete INTEGER DEFAULT 0, last_full_reconciled_at REAL, observation_sequence INTEGER DEFAULT 0);
    CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT);
    CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER DEFAULT 0);
    INSERT INTO local_thread_catalog_metadata VALUES (1,0);
    CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER DEFAULT 0, PRIMARY KEY(host_id,thread_id));
    CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT PRIMARY KEY, checkpoint TEXT, failed_at REAL);`);
  return db;
}

function storeClass(source) {
  const near = source.indexOf("class pP{");
  const code = ["pP", "pZ", "pG", "p_", "pM", "pY"].map(name => definition(source, name, near)).join(";");
  return evaluate(code, { czThreadVisibility: visibility, pk: "local", es: { iFb: 100 }, pB: schema, pV: schema, pT: {}, px: schema }, "pP");
}

function entry(id, cwd, updatedAt, recencyAt = updatedAt) {
  return { hostId: "local", threadId: id, displayTitle: id, cwd, sourceKind: "cli", sourceDetail: null, threadSource: null, modelProvider: "openai", gitBranch: null, sourceCreatedAt: 1, sourceUpdatedAt: updatedAt, sourceRecencyAt: recencyAt };
}

test("real patched catalog queries preserve assignment inclusion, aliases, exclusions and page boundaries", sqliteBundled, () => {
  const { main } = bundles();
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
  const near = source.indexOf("class efn{");
  const code = ["efn", "efi"].map(name => definition(source, name, near)).join(";");
  return evaluate(code, { czThreadVisibility: visibility, eu: { _gS: params => params?.threadId, P26: params => params?.thread }, Gi: () => null,
    pX: thread => thread.ephemeral ? null : entry(thread.id, thread.cwd, thread.updatedAt, thread.recencyAt) }, "efn");
}

test("real coordinator startup revalidates completed history and Activity updates the project catalog", sqliteBundled, async () => {
  const patched = patchThreadVisibilityMain(bundles().main);
  const Store = storeClass(patched), Coordinator = coordinatorClass(patched), db = catalogDatabase();
  const store = new Store(db);
  let now = 1000, coordinator;
  try {
    const firstScan = store.beginScan("full"); store.applyScanPage(firstScan, [entry("existing", "C:/repo", 1)]); store.completeScan(firstScan, 1, now);
    const modes = [], updates = [];
    const listing = visibility.createListing(async ({ useStateDbOnly }) => ({ data: useStateDbOnly ? [{ id: "existing", cwd: "C:/repo", updatedAt: 1, recencyAt: 1 }] : [{ id: "mobile", cwd: "C:\\Repo", updatedAt: 2, recencyAt: 2 }], nextCursor: null }), "local", []);
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

test("both bundled live stores refresh sort fields and their fallbacks never freeze recency", bundled, () => {
  const { main, renderer } = bundles();
  for (const [source, patch, fallbackName, context] of [
    [main, patchThreadVisibilityMain, "SM", { p$: id => id, S_: thread => ({ updatedAt: thread.updatedAt * 1000 }), SD: () => ({}), rc: () => false, t4: () => isDeepStrictEqual, SY: () => 0 }],
    [renderer, patchThreadVisibilityRenderer, "rd", { g: { J: id => id }, ru: thread => ({ updatedAt: thread.updatedAt * 1000 }), rh: () => ({}), nF: { sZ: () => false }, tD: () => isDeepStrictEqual, rc: () => 0 }],
  ]) {
    const patched = patch(source);
    const start = patched.indexOf("observeCatalogThreads(e){");
    const method = patched.slice(start, blockEnd(patched, start));
    const live = { id: "task", updatedAt: 1000, recencyAt: 1000, cwd: "old", title: "Task", resumeState: "needs_resume" };
    const instance = evaluate("", { czThreadVisibility: visibility, czObserveThread: visibility.applyObservation, czObservedActivity: visibility.observedActivity, ...context }, `({${method}})`);
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
    const recency = evaluate(definition(patched, fallbackName, patched.indexOf(`function ${fallbackName}(`)), {}, fallbackName);
    assert.equal(recency({ currentRecencyAt: 5, threadRecencyAt: null, updatedAt: 10 }), 10);
    assert.equal(recency({ currentRecencyAt: 20, threadRecencyAt: 10, updatedAt: 30 }), 20, "metadata updatedAt must not displace explicit recency");
  }
});
