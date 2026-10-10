import test from "node:test";
import assert from "node:assert/strict";
import visibility from "../assets/native-sidebar-threads.cjs";

const { DatabaseSync } = await import("node:sqlite").catch(() => ({}));
const sqlite = { skip: !DatabaseSync && "Node SQLite is unavailable" };

const { pathKey, pathSql, pathValues, pathPrefixes, findPathGroup, ensurePathIndexes,
  needsFullScan, setPolling, refreshActivity, applyObservation, createListing,
  mirrorProject, refreshUnknownProject } = visibility;

test("catalog paths match Windows forms without modifying records or folding POSIX case", sqlite, () => {
  const db = new DatabaseSync(":memory:");
  try {
    const paths = ["C:\\Users\\Test\\Repo\\", "c:/users/test/repo", "/mnt/c/Users/Test/Repo", "\\\\?\\C:\\Users\\Test\\Repo", "/C:/Users/Test/Repo", "\\\\?\\UNC\\Server\\Share\\Repo\\", "//server/share/repo", "C:\\Work\\Éxample\\", "/home/Repo", "/home/repo", "/", null];
    for (const path of paths) assert.equal(db.prepare(`SELECT ${pathSql()} AS key FROM (SELECT ? AS cwd)`).get(path).key, pathKey(path));
    assert.equal(pathKey(paths[0]), pathKey(paths[1]));
    assert.equal(pathKey(paths[0]), pathKey(paths[2]));
    assert.notEqual(pathKey("/home/Repo"), pathKey("/home/repo"));
    assert.deepEqual(pathValues(["C:\\Repo\\"]), ["/mnt/c/repo"]);
    assert.deepEqual(pathPrefixes(["C:\\Repo\\", "/mnt/c/REPO/sub/", "c:/repo/"]), ["/mnt/c/repo/"]);
    assert.deepEqual(pathPrefixes(["/home/repo", "/"]), ["/"]);
    assert.throws(() => pathPrefixes([""]), /Empty/);
  } finally { db.close(); }
});

test("canonical catalog exact and prefix lookups remain indexed and retain original cwd", sqlite, () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, cwd TEXT, source_recency_at REAL, source_created_at REAL, source_updated_at REAL, missing_candidate INTEGER)");
    const insert = db.prepare("INSERT INTO local_thread_catalog VALUES ('local', ?, ?, ?, 1, ?, 0)");
    insert.run("a", "C:\\Work\\Repo", 3, 3);
    insert.run("b", "c:/work/repo/sub", 2, 2);
    insert.run("c", "c:/work/repository", 1, 1);
    ensurePathIndexes(db); ensurePathIndexes(db);
    const expression = pathSql();
    const sql = `SELECT thread_id, cwd FROM local_thread_catalog INDEXED BY cz_thread_catalog_path_recent_idx WHERE host_id = ? AND missing_candidate = 0 AND ${expression} >= ? AND ${expression} < ? || char(1114111) ORDER BY source_recency_at DESC, source_created_at DESC, thread_id`;
    assert.deepEqual(db.prepare(sql).all("local", "/mnt/c/work/repo/", "/mnt/c/work/repo/").map(row => row.thread_id), ["b"]);
    const exact = `SELECT cwd FROM local_thread_catalog WHERE host_id = ? AND missing_candidate = 0 AND ${expression} = ?`;
    assert.equal(db.prepare(exact).get("local", "/mnt/c/work/repo").cwd, "C:\\Work\\Repo");
    assert.match(db.prepare("EXPLAIN QUERY PLAN " + exact).all("local", "/mnt/c/work/repo").map(row => row.detail).join(), /cz_thread_catalog_path_(recent|created)_idx/);
  } finally { db.close(); }
});

test("renderer path grouping picks the deepest saved root with directory boundaries", () => {
  const groups = new Map([[pathKey("C:/Repo"), "parent"], [pathKey("c:/repo/sub"), "nested"], ["/home/Repo", "upper"], ["/home/repo", "lower"]]);
  assert.equal(findPathGroup(groups, pathKey("C:\\REPO\\sub\\deep")), "nested");
  assert.equal(findPathGroup(groups, pathKey("/mnt/c/repo/other")), "parent");
  assert.equal(findPathGroup(groups, pathKey("C:/repository")), null);
  assert.equal(findPathGroup(groups, "/home/Repo/sub"), "upper");
  assert.equal(findPathGroup(groups, "/home/repo/sub"), "lower");
});

function thread(id, updatedAt, extra = {}) { return { id, updatedAt, recencyAt: updatedAt, ...extra }; }
function listingFixture(database, disk) {
  const calls = [];
  const listing = createListing(async params => {
    calls.push(params);
    const data = params.useStateDbOnly ? database : disk;
    const start = Number(params.cursor ?? 0);
    return { data: data.slice(start, start + params.limit), nextCursor: start + params.limit < data.length ? String(start + params.limit) : null };
  }, "local", ["cli", "vscode", "appServer"]);
  return { listing, calls };
}

test("independent database and recovery pagination merges newest metadata without losing older database tasks", async () => {
  const { listing, calls } = listingFixture([thread("db", 100), thread("duplicate", 60, { name: "old" }), thread("old", 5)], [thread("mobile", 120), thread("duplicate", 90, { name: "new" }), thread("disk", 10)]);
  const data = []; let cursor = null;
  do { const page = await listing({ cursor, limit: 2 }); data.push(...page.data); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(data.map(row => row.id), ["mobile", "db", "duplicate", "disk", "old"]);
  assert.equal(data.find(row => row.id === "duplicate").name, "new");
  assert.ok(calls.some(call => call.useStateDbOnly));
  assert.ok(calls.some(call => !call.useStateDbOnly));
  assert.ok(calls.every(call => call.sortKey === "updated_at" && call.parentThreadId === null && call.modelProviders.length === 0));
});

test("empty database, duplicate only pages, and repeated cursors cannot silently truncate recovery", async () => {
  const { listing } = listingFixture([], [thread("mobile", 2)]);
  assert.deepEqual((await listing({ cursor: null, limit: 1 })).data.map(row => row.id), ["mobile"]);
  const duplicate = listingFixture([thread("a", 4), thread("b", 3)], [thread("a", 4), thread("b", 3), thread("c", 2)]).listing;
  let page = await duplicate({ cursor: null, limit: 1 }), rows = [...page.data];
  while (page.nextCursor) { page = await duplicate({ cursor: page.nextCursor, limit: 1 }); rows.push(...page.data); }
  assert.deepEqual(rows.map(row => row.id), ["a", "b", "c"]);
  const looping = createListing(async () => ({ data: [], nextCursor: "same" }), "local", []);
  await assert.rejects(looping({ cursor: null, limit: 2 }), /Repeated/);
});

test("recovery failure aborts instead of declaring an incomplete full catalog authoritative", async () => {
  const listing = createListing(async params => {
    if (!params.useStateDbOnly) throw new Error("disk unavailable");
    return { data: [thread("existing", 1)], nextCursor: null };
  }, "local", []);
  await assert.rejects(listing({ cursor: null, limit: 2 }), /disk unavailable/);
  const remote = createListing(async params => { assert.equal(params.useStateDbOnly, true); return { data: [], nextCursor: null }; }, "remote-control:worker", []);
  await remote({ cursor: null, limit: 2 });
});

test("default catalog source filters retain custom chats and discover app server tasks", async () => {
  const calls = [];
  const listing = createListing(async params => {
    calls.push(params);
    return { data: params.sourceKinds.includes("appServer") ? [thread("mobile", 2)] : [thread("custom", 1)], nextCursor: null };
  }, "local", []);
  const page = await listing({ cursor: null, limit: 10 });
  assert.deepEqual(page.data.map(row => row.id), ["mobile", "custom"]);
  assert.equal(calls.length, 4);
});

test("activity observations advance existing live sort fields while stale snapshots cannot roll them back", () => {
  const conversation = { updatedAt: 10_000, recencyAt: 8_000, cwd: "old" };
  applyObservation(conversation, { updatedAt: 20, recencyAt: 19, cwd: "new" });
  assert.deepEqual(conversation, { updatedAt: 20_000, recencyAt: 19_000, cwd: "new" });
  applyObservation(conversation, { updatedAt: 5, recencyAt: 4, cwd: "stale" });
  assert.deepEqual(conversation, { updatedAt: 20_000, recencyAt: 19_000, cwd: "new" });
  applyObservation(conversation, { updatedAt: 30, cwd: "new" });
  assert.equal(conversation.recencyAt, 30_000);
});

test("activity reads coalesce changes and periodic reconciliation has a bounded lifetime", async t => {
  const calls = [];
  const coordinator = { store: { hostKind: "local" }, options: {}, syncEnabled: true, disposed: false,
    pendingThreadRefreshes: new Map(), dirtyThreadRefreshes: new Set(), refreshThread: (...args) => { calls.push(args); }, requestSync: async () => {} };
  refreshActivity(coordinator, "a"); refreshActivity(coordinator, "a");
  assert.equal(calls.length, 1); assert.equal(calls[0][2], "interactive");
  assert.ok(coordinator.dirtyThreadRefreshes.has("a"));
  t.mock.timers.enable({ apis: ["setInterval"] });
  let polls = 0; coordinator.requestSync = async () => { polls++; };
  setPolling(coordinator, true); t.mock.timers.tick(30_500); await Promise.resolve(); assert.equal(polls, 1);
  setPolling(coordinator, false); t.mock.timers.tick(30_500); assert.equal(polls, 1);
  assert.equal(needsFullScan({ isComplete: true, lastFullReconciliationAt: 100 }, "local", 300_100), true);
  assert.equal(needsFullScan({ isComplete: true, lastFullReconciliationAt: 100 }, "chatgpt", 300_100), false);
});

test("mobile project discovery mirrors only new unmapped projects and coalesces mapping refresh", async () => {
  const cached = { old: { id: "old" } }, writes = [], stores = [];
  const backend = { migrationIdentity: "local:home", cache: { getProjects: () => cached, writeProject: (_, project) => { cached[project.id] = project; writes.push(project); } },
    pendingDeletions: { get: (_, id) => id === "deleted" ? {} : null }, legacyProjectIdsByServerId: new Map(),
    listProjects: async () => { stores.push("list"); return [{ id: "mobile", name: "Mobile", roots: [{ path: "C:/repo" }], createdAt: 1, updatedAt: 2 }]; },
    storeProject(project) { this.legacyProjectIdsByServerId.set(project.id, project.id); mirrorProject(this, project, project.id); } };
  mirrorProject(backend, { id: "serverOld", name: "Old", roots: [{ path: "C:/old" }] }, "old");
  mirrorProject(backend, { id: "deleted", name: "Deleted", roots: [{ path: "C:/deleted" }] }, "deleted");
  assert.equal(writes.length, 0);
  await Promise.all([refreshUnknownProject(backend, "mobile", new AbortController().signal), refreshUnknownProject(backend, "mobile", new AbortController().signal)]);
  assert.equal(stores.length, 1); assert.equal(writes.length, 1); assert.deepEqual(writes[0].rootPaths, ["C:/repo"]);
  assert.equal(writes[0].createdAt, 1000);
});
