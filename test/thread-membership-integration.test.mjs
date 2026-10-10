import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { openAsar } from "../src/asar-patch.mjs";
import { patchThreadVisibilityMain, patchThreadVisibilityRenderer } from "../src/thread-visibility-patch.mjs";
import visibility from "../assets/native-sidebar-threads.cjs";

const archivePath = process.env.CODEXZERO_TEST_ASAR || "work/local-providers/20260921-reasoning-picker/desktop/resources/app.asar";

function between(source, startToken, endToken) {
  const start = source.indexOf(startToken), end = source.indexOf(endToken, start);
  assert.ok(start >= 0 && end > start, `Missing bundled extraction boundary: ${startToken}`);
  return source.slice(start, end);
}

function bundledClasses(source) {
  const keys = ["THREAD_PROJECT_ASSIGNMENTS", "PROJECTLESS_THREAD_IDS", "LOCAL_PROJECTS",
    "PROJECT_APPEARANCES", "PROJECT_ORDER", "APP_SERVER_PROJECTS_MIGRATION_BY_HOST",
    "APP_SERVER_PROJECT_ID_BY_LEGACY_PROJECT_ID_BY_HOST", "APP_SERVER_PENDING_PROJECT_DELETIONS_BY_HOST"];
  const n = { Hl: Object.fromEntries(keys.map(key => [key, key])), Iu: value => value,
    Xi: isDeepStrictEqual, $i: [], Ai: () => false,
    Du: version => version === "supported", Co: value => value ?? {}, So: value => value.projectAppearances,
    Yi(records, changes) {
      const assignments = { ...records.assignments }, projectless = new Set(records.projectlessThreadIds), memberships = {};
      for (const change of changes) {
        const old = { assignment: assignments[change.threadId] ?? null, projectless: projectless.has(change.threadId) };
        if (change.assignment == null) delete assignments[change.threadId];
        else assignments[change.threadId] = change.assignment;
        if (change.projectless) projectless.add(change.threadId); else projectless.delete(change.threadId);
        const next = { assignment: assignments[change.threadId] ?? null, projectless: projectless.has(change.threadId) };
        if (!isDeepStrictEqual(old, next)) memberships[change.threadId] = next;
      }
      return { records: { assignments, projectlessThreadIds: [...projectless] }, memberships };
    } };
  const logger = { info() {}, warning() {} };
  const classes = new Function("n", "r", "D", "czThreadVisibility", "Bn", "kr", `
    ${between(source, "async function f2(", "var O6e=")}
    const q="local",O6e=100,p2=8,A6e=30000,M6e=100,N6e=Symbol("project-order");
    const ${between(source, "k6e=class", ",A6e=")};
    const ${between(source, "j6e=class", ",M6e=")};
    const ${between(source, "P6e=class", ",m2=class")};
    const ${between(source, "m2=class", ",F6e=")};
    return { P6e, m2 };
  `)(n, { r: () => logger }, { setTimeout: delay }, visibility, value => value,
    state => state.get(n.Hl.LOCAL_PROJECTS) ?? {});
  return { ...classes, n };
}

function fixture(classes, { assignment, serverProjectId = "server-B", checkpoint, supported = true } = {}) {
  const { P6e, m2, n } = classes;
  const identity = "local:fixture", events = [], mutations = [], publishes = [], writes = [];
  const values = {
    [n.Hl.LOCAL_PROJECTS]: {}, [n.Hl.THREAD_PROJECT_ASSIGNMENTS]: assignment ? { mobile: assignment } : {},
    [n.Hl.PROJECTLESS_THREAD_IDS]: [], [n.Hl.APP_SERVER_PROJECTS_MIGRATION_BY_HOST]: checkpoint ? { [identity]: checkpoint } : {},
  };
  const globalState = {
    get: key => values[key],
    set(key, value) { writes.push({ key, value }); values[key] = value; },
    update(key, callback) { this.set(key, callback(this.get(key))); },
    async flushOrThrow() {},
  };
  let currentProjectId = serverProjectId;
  const projects = new Map();
  const connection = { hostConfig: { id: "local" }, appServerVersion: supported ? "supported" : "unsupported",
    async codexHome() { return "fixture"; },
    async sendAppServerRequest(method, params) {
      events.push(method);
      if (method === "thread/list") return { data: [{ id: "mobile", projectId: currentProjectId }], nextCursor: null };
      if (method === "thread/read") return { thread: { id: "mobile", projectId: currentProjectId } };
      if (method === "thread/metadata/update") { mutations.push(params); currentProjectId = params.projectId; return {}; }
      if (method === "project/list") return { data: [...projects.values()], nextCursor: null };
      throw new Error(`Unexpected integration request: ${method}`);
    } };
  let projectChanges = 0;
  const backend = new P6e(globalState, connection, new m2(globalState), value => publishes.push(value),
    () => { projectChanges++; events.push("project-change"); });
  backend.migrationIdentity = identity;
  if (supported) { backend.projectSupport = "supported"; backend.projectsReady = true; }
  backend.setThreadAssignmentsEnabled(true);
  function project(id, name = id) { return { id, name, roots: [{ path: `C:/repos/${id}` }], createdAt: 1, updatedAt: 2 }; }
  function cachedProject(serverId, localId) {
    const item = project(serverId);
    values[n.Hl.LOCAL_PROJECTS][localId] = { id: localId, name: "Local name", rootPaths: ["C:/local"], createdAt: 1, updatedAt: 2 };
    backend.storeProject(item, localId);
    return item;
  }
  return { backend, globalState, values, n, identity, connection, events, mutations, publishes, writes, projects,
    project, cachedProject, projectChanges: () => projectChanges, serverProjectId: () => currentProjectId };
}

test("real bundled membership ingestion preserves authoritative and explicitly queued project choices", { skip: !fs.existsSync(archivePath) }, async t => {
  const archive = await openAsar(archivePath);
  let main, renderer;
  try {
    const mainFiles = Object.keys(archive.header.files[".vite"].files.build.files);
    const rendererFiles = Object.keys(archive.header.files.webview.files.assets.files);
    const mainName = mainFiles.find(name => /^main-.*\.js$/.test(name));
    const rendererName = rendererFiles.find(name => /^app-initial-.*\.js$/.test(name));
    assert.ok(mainName && rendererName, "Expected pinned native bundles");
    main = (await archive.read(`.vite/build/${mainName}`)).toString("utf8");
    renderer = (await archive.read(`webview/assets/${rendererName}`)).toString("utf8");
  } finally { await archive.close(); }
  const patchedMain = patchThreadVisibilityMain(main), patchedRenderer = patchThreadVisibilityRenderer(renderer);
  const classes = bundledClasses(patchedMain), signal = () => new AbortController().signal;
  assert.throws(() => patchThreadVisibilityMain(patchedMain));
  assert.throws(() => patchThreadVisibilityRenderer(patchedRenderer));

  await t.test("first migration adopts a different authoritative mobile project without overwriting it", async () => {
    const f = fixture(classes, { assignment: { projectKind: "local", projectId: "legacy-A" } });
    f.cachedProject("server-A", "legacy-A"); f.cachedProject("server-B", "legacy-B");
    await f.backend.threadAssignments.migrate(f.identity, signal());
    assert.deepEqual(f.mutations, []);
    assert.equal(f.serverProjectId(), "server-B");
    assert.deepEqual(f.values[f.n.Hl.THREAD_PROJECT_ASSIGNMENTS].mobile, { projectKind: "local", projectId: "legacy-B" });
    assert.equal(f.publishes.length, 1);
  });

  await t.test("explicit queued desktop membership still replays over a different server project", async () => {
    const f = fixture(classes, { assignment: { projectKind: "local", projectId: "legacy-A" },
      checkpoint: { threadAssignmentsMigrated: false, threadAssignmentsReadMigrated: true, pendingThreadAssignmentIds: ["mobile"] } });
    f.cachedProject("server-A", "legacy-A"); f.cachedProject("server-B", "legacy-B");
    await f.backend.threadAssignments.migrate(f.identity, signal());
    assert.deepEqual(f.mutations, [{ threadId: "mobile", projectId: "server-A" }]);
    assert.equal(f.values[f.n.Hl.THREAD_PROJECT_ASSIGNMENTS].mobile.projectId, "legacy-A");
    assert.deepEqual(f.values[f.n.Hl.APP_SERVER_PROJECTS_MIGRATION_BY_HOST][f.identity].pendingThreadAssignmentIds, []);
  });

  await t.test("legacy null server membership still seeds the saved desktop assignment", async () => {
    const f = fixture(classes, { assignment: { projectKind: "local", projectId: "legacy-A" }, serverProjectId: null });
    f.cachedProject("server-A", "legacy-A");
    await f.backend.threadAssignments.migrate(f.identity, signal());
    assert.deepEqual(f.mutations, [{ threadId: "mobile", projectId: "server-A" }]);
    assert.equal(f.values[f.n.Hl.THREAD_PROJECT_ASSIGNMENTS].mobile.projectId, "legacy-A");
  });

  await t.test("unmapped mobile projects mirror into the cache and invalidate project consumers once", () => {
    const f = fixture(classes), item = f.project("mobile-project", "Mobile project");
    f.backend.storeProject(item); f.backend.storeProject(item);
    assert.deepEqual(f.values[f.n.Hl.LOCAL_PROJECTS][item.id], { id: item.id, name: item.name,
      rootPaths: ["C:/repos/mobile-project"], createdAt: 1000, updatedAt: 2000 });
    assert.equal(f.projectChanges(), 1);
  });

  await t.test("existing mapped projects and pending deleted projects are never recreated", () => {
    const f = fixture(classes);
    f.cachedProject("mapped-server", "legacy-local");
    const existing = f.values[f.n.Hl.LOCAL_PROJECTS]["legacy-local"];
    f.backend.storeProject(f.project("mapped-server", "Remote name"));
    f.backend.legacyProjectIdsByServerId.set("mapped-missing-server", "removed-legacy");
    f.backend.storeProject(f.project("mapped-missing-server"));
    f.backend.pendingDeletions.set(f.identity, "deleted", { projectId: "deleted", deleteAfterMs: Date.now() + 60_000 });
    f.backend.storeProject(f.project("deleted"));
    assert.equal(f.values[f.n.Hl.LOCAL_PROJECTS]["legacy-local"], existing);
    assert.equal(f.values[f.n.Hl.LOCAL_PROJECTS]["mapped-server"], undefined);
    assert.equal(f.values[f.n.Hl.LOCAL_PROJECTS]["mapped-missing-server"], undefined);
    assert.equal(f.values[f.n.Hl.LOCAL_PROJECTS]["removed-legacy"], undefined);
    assert.equal(f.values[f.n.Hl.LOCAL_PROJECTS].deleted, undefined);
    assert.equal(f.projectChanges(), 0);
  });

  await t.test("observed unknown project refreshes mappings before adopting membership", async () => {
    const f = fixture(classes, { serverProjectId: "mobile-project", checkpoint: {
      threadAssignmentsMigrated: true, threadAssignmentsReadMigrated: true, pendingThreadAssignmentIds: [] } });
    f.projects.set("mobile-project", f.project("mobile-project"));
    f.backend.observeThreads([{ id: "mobile", projectId: "mobile-project" }]);
    await f.backend.membershipSync;
    assert.deepEqual(f.events, ["project/list", "project-change", "thread/read"]);
    assert.deepEqual(f.values[f.n.Hl.THREAD_PROJECT_ASSIGNMENTS].mobile, { projectKind: "local", projectId: "mobile-project" });
    assert.equal(f.publishes.length, 1);
    assert.deepEqual(f.mutations, []);
  });

  await t.test("unsupported native core keeps assignment edits local and sends no project requests", async () => {
    const f = fixture(classes, { supported: false });
    let localWrites = 0;
    await f.backend.writeThreadAssignment("mobile", { projectKind: "local", projectId: "legacy-A" },
      async () => { localWrites++; }, undefined, "local");
    f.backend.observeThreads([{ id: "mobile", projectId: "unknown-server-project" }]);
    await f.backend.membershipSync;
    assert.equal(await f.backend.getThreadStartProjectId({ projectKind: "local", projectId: "legacy-A" }), null);
    assert.equal(f.backend.projectSupport, "unsupported");
    assert.equal(localWrites, 1);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.mutations, []);
  });

  await t.test("renderer never infers another cwd project for an unresolved explicit assignment", () => {
    const groupMatcher = new Function(between(patchedRenderer, "function Tni(e,t){", "function Eni(") + ";return Tni;")();
    const start = patchedRenderer.indexOf("Bni=(e,t,n,r,i,a,o=jp,s)=>"), end = patchedRenderer.indexOf("}})))()}var Vni", start);
    assert.ok(start >= 0 && end > start, "Expected bundled project grouping callback");
    const context = { jp: "local", Vr: () => false, Tni: groupMatcher, k9r: value => [value], kni: () => [],
      sa: () => false, Ani: () => false, hti: () => null, wni: () => null, Sni: (map, cwd) => map.get(cwd) };
    const group = { projectId: "project-B", projectKind: "local", path: "C:/repo", threadKeys: [] };
    const entry = { hostId: "local", conversationId: "mobile", cwd: "C:/repo", key: "local:mobile", workspaceKind: "project" };
    const groupThread = new Function(...Object.keys(context), "return (" + patchedRenderer.slice(start + "Bni=".length, end + 1) + ");")(...Object.values(context));
    groupThread(entry, [group], new Map([[entry.cwd, group]]), [], undefined, undefined, "local", {
      threadProjectAssignments: { mobile: { projectKind: "local", projectId: "missing-project-A" } } });
    assert.deepEqual(group.threadKeys, []);
    groupThread(entry, [group], new Map([[entry.cwd, group]]), [], undefined, undefined, "local", {});
    assert.deepEqual(group.threadKeys, [entry.key], "Legacy unassigned cwd inference remains available");
  });

  await t.test("unresolved saved assignments stay in Recents or Pinned while hidden auxiliary threads remain excluded", () => {
    const threadKey = "local:mobile", hiddenKey = "local:hidden";
    const assignment = { projectKind: "local", projectId: "pending-project" };
    const tasks = new Map([
      [threadKey, { kind: "local", key: threadKey, conversation: { id: "mobile", hostId: "local", originator: "codex_work_mobile" } }],
      [hiddenKey, { kind: "local", key: hiddenKey, conversation: { id: "hidden", hostId: "local", threadSource: "chatgpt_hidden" } }],
    ]);
    const nr = { LOCAL_PROJECTS: "projects", THREAD_PROJECT_ASSIGNMENTS: "assignments" };
    const osiContext = { $: {}, uf: (_, callback) => callback, Jv: () => ({ isSuccess: true, data: {} }), Nr: nr,
      JF: "JF", cI: "cI", gQn: task => ({ threadId: task.conversation.id }), qv: () => ({ mobile: assignment }) };
    const originalOsi = new Function(...Object.keys(osiContext),
      "let " + between(renderer, "Osi=uf($,", ",fI=sf") + ";return Osi;")(...Object.values(osiContext));
    function get(token, key) {
      if (token === "JF") return tasks.get(key);
      if (token === "Osi") return originalOsi(key, { get });
      if (token === "Dsi") return new Set();
      return null;
    }
    assert.equal(originalOsi(threadKey, { get }), true, "The original project cache predicate considers this valid row unresolved");
    const context = { Tsi: { allSidebarThreadKeys: [], pinnedThreadKeys: [], unpinnedThreadKeys: [] },
      JF: "JF", Osi: "Osi", lI: "lI", RT: key => key.slice(6),
      gQn: task => ({ key: task.key, threadId: task.conversation.id, pendingWorktreeId: null }),
      Poi: new Function(between(renderer, "function Poi({", "function Foi(") + ";return Poi;")(),
      Ssi: new Function(between(renderer, "function Ssi(e){", "var Csi,") + ";return Ssi;")(),
      xsi: new Function("Dsi", "gT", "qv", "Jv", "Nr",
        between(renderer, "function xsi({", "function Ssi(e){") + ";return xsi;")(
          "Dsi", key => key, () => ({ mobile: assignment }), () => ({ isSuccess: true, data: {} }), nr) };
    const compile = source => new Function(...Object.keys(context),
      between(source, "function bsi({", "function xsi({") + ";return bsi;")(...Object.values(context));
    const originalBsi = compile(renderer), patchedBsi = compile(patchedRenderer);
    assert.deepEqual(originalBsi({ get, threadKeys: [threadKey], pinnedThreadIds: [] }).allSidebarThreadKeys, []);
    assert.deepEqual(originalBsi({ get, threadKeys: [threadKey], pinnedThreadIds: ["mobile"] }).allSidebarThreadKeys, []);
    const unpinned = patchedBsi({ get, threadKeys: [threadKey, hiddenKey], pinnedThreadIds: [] });
    assert.deepEqual(unpinned.allSidebarThreadKeys, [threadKey]);
    assert.deepEqual(unpinned.unpinnedThreadKeys, [threadKey]);
    const rOi = new Function(between(renderer, "function rOi({", "function aOi(") + ";return rOi;")();
    assert.deepEqual(rOi({ items: unpinned.unpinnedThreadKeys.map(key => ({ task: tasks.get(key), isPinned: false, recencyAt: 1 })),
      projectGroups: [], projectlessThreadIds: new Set() }), [threadKey], "Ungrouped valid rows remain in the normal chat section");
    const pinned = patchedBsi({ get, threadKeys: [threadKey, hiddenKey], pinnedThreadIds: ["mobile", "hidden"] });
    assert.deepEqual(pinned.allSidebarThreadKeys, [threadKey]);
    assert.deepEqual(pinned.pinnedThreadKeys, [threadKey]);
    assert.deepEqual(pinned.unpinnedThreadKeys, []);
    const remoteKey = "local:remote-core", durableKey = "local:durable";
    tasks.set(remoteKey, { kind: "local", key: remoteKey, conversation: {
      id: "remote-core", hostId: "remote-control:fixture", originator: "codex_work_mobile" } });
    tasks.set(durableKey, { kind: "local", key: durableKey, conversation: {
      id: "durable", hostId: "durable", originator: "codex_work_mobile" } });
    assert.deepEqual(patchedBsi({ get, threadKeys: [remoteKey, durableKey], pinnedThreadIds: [] }).allSidebarThreadKeys, [remoteKey],
      "The preserved durable Work filter does not apply to a connected remote core host");
    assert.deepEqual(patchedBsi({ get, threadKeys: [durableKey], pinnedThreadIds: ["durable"] }).pinnedThreadKeys, [durableKey]);
  });

  await t.test("real project grouping matches nearest canonical root without boundary or case collisions", () => {
    assert.equal(typeof visibility.findPathGroup, "function");
    const context = {
      czPathKey: visibility.pathKey, czFindPathGroup: visibility.findPathGroup,
      on: value => value.replaceAll("\\", "/").replace(/\/+$/, ""),
      bF: group => group.rootPaths ?? [group.path], _ni: () => false,
      hni: new Function(between(patchedRenderer, "function hni(e){", "function gni(") + ";return hni;")(),
      gni: new Function(between(patchedRenderer, "function gni(e){", "function _ni(") + ";return gni;")(),
    };
    const fni = new Function(...Object.keys(context),
      between(patchedRenderer, "function fni(e){", "function pni(") + ";return fni;")(...Object.values(context));
    const Sni = new Function(...Object.keys(context),
      between(patchedRenderer, "function Sni(e,t){", "function Cni(") + ";return Sni;")(...Object.values(context));
    const Tni = new Function(between(patchedRenderer, "function Tni(e,t){", "function Eni(") + ";return Tni;")();
    const groupingContext = { jp: "local", Vr: () => false, Tni, k9r: value => [value], kni: () => [],
      sa: () => false, Ani: () => false, hti: () => null, wni: () => null, Sni };
    const start = patchedRenderer.indexOf("Bni=(e,t,n,r,i,a,o=jp,s)=>"), end = patchedRenderer.indexOf("}})))()}var Vni", start);
    assert.ok(start >= 0 && end > start);
    const Bni = new Function(...Object.keys(groupingContext),
      "return (" + patchedRenderer.slice(start + "Bni=".length, end + 1) + ");")(...Object.values(groupingContext));
    const project = (id, path, extra = {}) => ({ projectId: id, projectKind: "local", path, rootPaths: [path], threadKeys: [], ...extra });
    function matchingProject(groups, cwd, assignment) {
      for (const group of groups) group.threadKeys.length = 0;
      Bni({ hostId: "local", conversationId: "mobile", cwd, key: "local:mobile", workspaceKind: "project" },
        groups, fni(groups), [], undefined, undefined, "local", {
          threadProjectAssignments: assignment ? { mobile: assignment } : {} });
      return groups.filter(group => group.threadKeys.length).map(group => group.projectId);
    }
    const nested = [project("parent", "/home/repo"), project("nested", "/home/repo/pkg")];
    assert.deepEqual(matchingProject(nested, "/home/repo/pkg/src"), ["nested"]);
    assert.deepEqual(matchingProject(nested, "/home/repo/other"), ["parent"]);
    assert.deepEqual(matchingProject(nested, "/home/repository/src"), []);
    const caseSensitive = [project("upper", "/home/Repo"), project("lower", "/home/repo")];
    assert.deepEqual(matchingProject(caseSensitive, "/home/Repo/sub"), ["upper"]);
    assert.deepEqual(matchingProject(caseSensitive, "/home/repo/sub"), ["lower"]);
    assert.deepEqual(matchingProject(caseSensitive, "/home/REPO/sub"), []);
    const windows = [project("windows", "C:\\Work\\Repo", {
      rootPathAliases: [{ alias: "/mnt/c/work/repo", path: "C:\\Work\\Repo" }] })];
    for (const cwd of ["c:/work/repo/sub", "/mnt/c/WORK/Repo/sub", "/C:/Work/Repo/sub", "\\\\?\\C:\\WORK\\REPO\\sub"]) {
      assert.deepEqual(matchingProject(windows, cwd), ["windows"], cwd);
    }
    assert.deepEqual(matchingProject([project("unc", "\\\\Server\\Share\\Repo")], "//server/share/repo/sub"), ["unc"]);
    assert.deepEqual(matchingProject(nested, "/home/repo/pkg/src", {
      projectKind: "local", projectId: "unresolved-project" }), [], "Explicit unresolved assignment never falls back to an ancestor project");
    const Vti = new Function("czPathKey", between(patchedRenderer, "function Vti({", "function MF(") + ";return Vti;")(visibility.pathKey);
    const scope = (cwdValues, threadWorkspaceRootHints, extra = {}) => Vti({ projectId: "repo", projectKind: "local",
      hostIds: ["local"], cwdValues, threadWorkspaceRootHints, projectlessThreadIds: [], threadProjectAssignments: {}, ...extra });
    assert.deepEqual(scope(["C:\\Work\\Repo"], { mobile: "/mnt/c/WORK/Repo" }).filter.includeThreadIds, ["mobile"]);
    assert.deepEqual(scope(["/home/Repo"], { upper: "/home/Repo", lower: "/home/repo" }).filter.includeThreadIds, ["upper"]);
    assert.deepEqual(scope(["/home/repo"], { upper: "/home/Repo", lower: "/home/repo" }).filter.includeThreadIds, ["lower"]);
    const mismatched = scope(["C:\\Work\\Repo"], { mobile: "/mnt/c/WORK/Repo" }, {
      threadProjectAssignments: { mobile: { projectKind: "local", projectId: "another-project" } } });
    assert.deepEqual(mismatched.filter.includeThreadIds, []);
    assert.deepEqual(mismatched.filter.excludeThreadIds, ["mobile"]);
    const Wai = new Function("fni", "czPathKey", "bF",
      between(patchedRenderer, "function Wai(e,t){", "function Gai(") + ";return Wai;")(fni, visibility.pathKey, context.bF);
    assert.deepEqual(Wai(windows[0], windows), ["C:\\Work\\Repo", "/mnt/c/work/repo"]);
    assert.deepEqual(Wai(caseSensitive[0], caseSensitive), ["/home/Repo"]);
  });
});
