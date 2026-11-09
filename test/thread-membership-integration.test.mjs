import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { patchThreadVisibilityMain, patchThreadVisibilityRenderer, THREAD_VISIBILITY_MAIN_TARGET, THREAD_VISIBILITY_RENDERER_TARGET } from "../src/thread-visibility-patch.mjs";
import visibility from "../assets/native-sidebar-threads.cjs";
import { bundledAvailable, bundledSources, blockEnd, definition, evaluate } from "./bundled-source.mjs";

const LEGACY_MAP = "app-server-project-id-by-legacy-project-id-by-host";
const keys = new Proxy({ APP_SERVER_PROJECT_ID_BY_LEGACY_PROJECT_ID_BY_HOST: LEGACY_MAP }, { get: (target, key) => target[key] ?? key });
const schema = { safeParse: data => ({ success: true, data }) };

function mergeMemberships(records, changes) {
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
}

function bundledClasses(source) {
  const near = source.indexOf("class eui{");
  const constants = source.slice(source.indexOf('ed6="codex.chatGptBacking"', near - 2000), source.indexOf(";class eui{", near - 2000));
  const code = `const ${constants};` + ["ed5", "ed4", "ed8", "eul", "eui", "eua", "euo", "eus", "ed9", "ed3"].map(name => definition(source, name, near)).join(";");
  const logger = { info() {}, warning() {}, error() {} };
  const updateProject = (state, id, update) => {
    const projects = { ...state.get(keys.LOCAL_PROJECTS) }, next = projects[id] == null ? null : update(projects[id]);
    if (next == null) delete projects[id]; else projects[id] = next;
    state.set(keys.LOCAL_PROJECTS, projects);
  };
  return evaluate(code, { czThreadVisibility: visibility, sy: { n: "local" }, kL: { setTimeout: delay }, tg: crypto, v6: [], t4: () => isDeepStrictEqual,
    bJ: error => error?.code, eS: value => value, eT: async roots => roots, YV: () => ({ acquire: async () => true, release: async () => {} }),
    eu: { $Cz: () => logger, P26: params => params?.thread, _gS: params => params?.threadId, cPM: () => null },
    eX: { QN: state => state.get(keys.LOCAL_PROJECTS) ?? {}, OQ: updateProject },
    es: { Q2Y: keys, Np8: id => id, JXB: id => id, K7L: 30 * 86_400_000, JFB: version => version === "supported", Mxp: mergeMemberships,
      RWz: (a, b) => isDeepStrictEqual(a ?? null, b ?? null), OS5: value => value ?? {}, ePA: ({ projectAppearances, projectId, appearance }) => ({ ...projectAppearances, [projectId]: appearance }), Lnj: schema, AvD: schema } },
  "({ eui, eul })");
}

function fixture(classes, { assignment, serverProjectId = "server-B", checkpoint, supported = true } = {}) {
  const { eui, eul } = classes;
  const identity = "local:fixture", events = [], mutations = [], publishes = [], writes = [];
  const values = {
    [keys.LOCAL_PROJECTS]: {}, [keys.THREAD_PROJECT_ASSIGNMENTS]: assignment ? { mobile: assignment } : {},
    [keys.PROJECTLESS_THREAD_IDS]: [], [keys.APP_SERVER_PROJECTS_MIGRATION_BY_HOST]: checkpoint ? { [identity]: checkpoint } : {},
  };
  const globalState = {
    get: key => values[key],
    set(key, value) { writes.push({ key, value }); values[key] = value; },
    update(key, callback) { this.set(key, callback(this.get(key))); },
    async flushOrThrow() {},
  };
  let currentProjectId = serverProjectId;
  const projects = new Map();
  const connection = { hostConfig: { id: "local", kind: "local" }, appServerVersion: supported ? "supported" : "unsupported",
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
  const backend = new eui(globalState, connection, new eul(globalState), value => publishes.push(value),
    () => { projectChanges++; events.push("project-change"); });
  backend.migrationIdentity = identity;
  if (supported) { backend.projectSupport = "supported"; backend.projectsReady = true; }
  backend.setThreadAssignmentsEnabled(true);
  function project(id, name = id) { return { id, name, roots: [{ path: `C:/repos/${id}` }], metadata: {}, createdAt: 1, updatedAt: 2 }; }
  function cachedProject(serverId, localId) {
    const item = project(serverId);
    values[keys.LOCAL_PROJECTS][localId] = { id: localId, name: "Local name", rootPaths: ["C:/local"], createdAt: 1, updatedAt: 2 };
    backend.storeProject(item, localId);
    return item;
  }
  return { backend, globalState, values, identity, connection, events, mutations, publishes, writes, projects,
    project, cachedProject, projectChanges: () => projectChanges, serverProjectId: () => currentProjectId };
}

const bundled = { skip: !bundledAvailable && "Unpacked desktop bundle unavailable" };

test("real bundled membership ingestion preserves authoritative and explicitly queued project choices", bundled, async t => {
  const { main, renderer } = bundledSources({ main: THREAD_VISIBILITY_MAIN_TARGET, renderer: THREAD_VISIBILITY_RENDERER_TARGET });
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
    assert.deepEqual(f.values[keys.THREAD_PROJECT_ASSIGNMENTS].mobile, { projectKind: "local", projectId: "legacy-B" });
    assert.equal(f.publishes.length, 1);
  });

  await t.test("explicit queued desktop membership still replays over a different server project", async () => {
    const f = fixture(classes, { assignment: { projectKind: "local", projectId: "legacy-A" },
      checkpoint: { threadAssignmentsMigrated: false, threadAssignmentsReadMigrated: true, pendingThreadAssignmentIds: ["mobile"] } });
    f.cachedProject("server-A", "legacy-A"); f.cachedProject("server-B", "legacy-B");
    await f.backend.threadAssignments.migrate(f.identity, signal());
    assert.deepEqual(f.mutations, [{ threadId: "mobile", projectId: "server-A" }]);
    assert.equal(f.values[keys.THREAD_PROJECT_ASSIGNMENTS].mobile.projectId, "legacy-A");
    assert.deepEqual(f.values[keys.APP_SERVER_PROJECTS_MIGRATION_BY_HOST][f.identity].pendingThreadAssignmentIds, []);
  });

  await t.test("legacy null server membership still seeds the saved desktop assignment", async () => {
    const f = fixture(classes, { assignment: { projectKind: "local", projectId: "legacy-A" }, serverProjectId: null });
    f.cachedProject("server-A", "legacy-A");
    await f.backend.threadAssignments.migrate(f.identity, signal());
    assert.deepEqual(f.mutations, [{ threadId: "mobile", projectId: "server-A" }]);
    assert.equal(f.values[keys.THREAD_PROJECT_ASSIGNMENTS].mobile.projectId, "legacy-A");
  });

  await t.test("unmapped mobile projects mirror into the cache and invalidate project consumers once", () => {
    const f = fixture(classes), item = f.project("mobile-project", "Mobile project");
    f.backend.storeProject(item); f.backend.storeProject(item);
    const { id, name, rootPaths, createdAt, updatedAt } = f.values[keys.LOCAL_PROJECTS][item.id];
    assert.deepEqual({ id, name, rootPaths, createdAt, updatedAt }, { id: item.id, name: item.name,
      rootPaths: ["C:/repos/mobile-project"], createdAt: 1000, updatedAt: 2000 });
    assert.equal(f.projectChanges(), 1);
  });

  await t.test("existing mapped projects and pending deleted projects are never recreated", () => {
    const f = fixture(classes);
    f.cachedProject("mapped-server", "legacy-local");
    const existing = f.values[keys.LOCAL_PROJECTS]["legacy-local"];
    f.backend.storeProject(f.project("mapped-server", "Remote name"));
    f.backend.legacyProjectIdsByServerId.set("mapped-missing-server", "removed-legacy");
    f.backend.storeProject(f.project("mapped-missing-server"));
    f.backend.pendingDeletions.set(f.identity, "deleted", { projectId: "deleted", deleteAfterMs: Date.now() + 60_000 });
    f.backend.storeProject(f.project("deleted"));
    f.backend.pendingDeletions.stop();
    assert.equal(f.values[keys.LOCAL_PROJECTS]["legacy-local"], existing);
    assert.equal(f.values[keys.LOCAL_PROJECTS]["mapped-server"], undefined);
    assert.equal(f.values[keys.LOCAL_PROJECTS]["mapped-missing-server"], undefined);
    assert.equal(f.values[keys.LOCAL_PROJECTS]["removed-legacy"], undefined);
    assert.equal(f.values[keys.LOCAL_PROJECTS].deleted, undefined);
    assert.equal(f.projectChanges(), 0);
  });

  await t.test("projects mapped by another instance sharing the home are not mirrored as duplicates", () => {
    const f = fixture(classes);
    f.values[LEGACY_MAP] = { [f.identity]: { "legacy-shared": "server-shared" } };
    f.backend.storeProject(f.project("server-shared"));
    f.backend.storeProject(f.project("server-shared"));
    assert.equal(f.values[keys.LOCAL_PROJECTS]["server-shared"], undefined);
    assert.equal(f.projectChanges(), 0);
    f.values[LEGACY_MAP] = { "local:other-home": { "legacy-other": "server-other" } };
    f.backend.storeProject(f.project("server-other"));
    assert.equal(f.values[keys.LOCAL_PROJECTS]["server-other"].id, "server-other", "maps for other identities do not suppress mirroring");
  });

  await t.test("observed unknown project refreshes mappings before adopting membership", async () => {
    const f = fixture(classes, { serverProjectId: "mobile-project", checkpoint: {
      threadAssignmentsMigrated: true, threadAssignmentsReadMigrated: true, pendingThreadAssignmentIds: [] } });
    f.projects.set("mobile-project", f.project("mobile-project"));
    f.backend.observeThreads([{ id: "mobile", projectId: "mobile-project" }]);
    await f.backend.membershipSync;
    assert.deepEqual(f.events, ["project/list", "project-change", "thread/read"]);
    assert.deepEqual(f.values[keys.THREAD_PROJECT_ASSIGNMENTS].mobile, { projectKind: "local", projectId: "mobile-project" });
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

  const grouping = patchedRenderer.indexOf("function C(e){let t=e.filter(");
  const helpers = ["C", "A", "S", "b", "w", "T"].map(name => definition(patchedRenderer, name, grouping)).join(";");
  const callbackStart = patchedRenderer.indexOf("(e,t,n,r,i,a,o=h.fI,l)=>{");
  const callback = patchedRenderer.slice(callbackStart, blockEnd(patchedRenderer, callbackStart));
  const groupingContext = { czPathKey: visibility.pathKey, czFindPathGroup: visibility.findPathGroup, h: { fI: "local" },
    c: { l_: group => group.rootPaths ?? [group.path], qZ: value => [value] }, g: { JH: value => value }, p: { xX: () => false, UT: () => null },
    u: { ZJQ: () => false, n9x: () => false, qPI: value => value, PuL: () => false }, s: () => ({}) };
  const { groups, assign } = evaluate(helpers, groupingContext, `({ groups: C, assign: (${callback}) })`);
  function matchingProject(list, cwd, assignment) {
    for (const group of list) group.threadKeys.length = 0;
    assign({ hostId: "local", conversationId: "mobile", cwd, key: "local:mobile", workspaceKind: "project" },
      list, groups(list), [], undefined, undefined, "local", { threadProjectAssignments: assignment ? { mobile: assignment } : {} });
    return list.filter(group => group.threadKeys.length).map(group => group.projectId);
  }
  const project = (id, path, extra = {}) => ({ projectId: id, projectKind: "local", path, rootPaths: [path], threadKeys: [], ...extra });

  await t.test("renderer never infers another cwd project for an unresolved explicit assignment", () => {
    const list = [project("project-B", "C:/repo")];
    assert.deepEqual(matchingProject(list, "C:/repo", { projectKind: "local", projectId: "missing-project-A" }), []);
    assert.deepEqual(matchingProject(list, "C:/repo"), ["project-B"], "Legacy unassigned cwd inference remains available");
  });

  await t.test("unresolved saved assignments stay in Recents or Pinned while hidden auxiliary threads remain excluded", () => {
    const filterStart = patchedRenderer.indexOf("r=function({get:e,threadKeys:t,pinnedThreadIds:n}){");
    const filter = patchedRenderer.slice(filterStart + 2, blockEnd(patchedRenderer, patchedRenderer.indexOf("){", filterStart) + 1));
    assert.doesNotMatch(filter, /"chatgpt"!==i\.projectOrigin/, "Missing project metadata no longer hides assigned rows");
    const threadKey = "local:mobile", hiddenKey = "local:hidden", durableKey = "local:durable", remoteKey = "local:remote-core";
    const identities = { [threadKey]: { conversationId: "mobile", hostId: "local", originator: "codex_work_mobile" },
      [hiddenKey]: { conversationId: "hidden", hostId: "local", threadSource: "chatgpt_hidden" },
      [durableKey]: { conversationId: "durable", hostId: "durable", originator: "codex_work_mobile" },
      [remoteKey]: { conversationId: "remote-core", hostId: "remote-control:fixture", originator: "codex_work_mobile" } };
    const projects = {}, assignments = { mobile: { projectKind: "local", projectId: "pending-project" } };
    const filterContext = { C: { allSidebarThreadKeys: [], pinnedThreadKeys: [], unpinnedThreadKeys: [] }, A: "A",
      b: (_, key) => identities[key] && { reference: { key, threadId: identities[key].conversationId }, identity: identities[key] },
      l: { Mo: "Mo", F6: (_, key) => key === "projects" ? projects : assignments }, s: { Q2Y: { LOCAL_PROJECTS: "projects", THREAD_PROJECT_ASSIGNMENTS: "assignments" }, iwv: "durable" },
      o: { wC: "chatgpt_hidden" }, p: { h8: key => key }, _: { PK: key => key.slice(6) }, d: { Tr: ({ threadKeys }) => threadKeys } };
    const visible = evaluate("", filterContext, `(${filter})`);
    const get = token => token === "A" ? new Set() : { isSuccess: true };
    const unpinned = visible({ get, threadKeys: [threadKey, hiddenKey], pinnedThreadIds: [] });
    assert.deepEqual(unpinned.allSidebarThreadKeys, [threadKey]);
    assert.deepEqual(unpinned.unpinnedThreadKeys, [threadKey]);
    const pinned = visible({ get, threadKeys: [threadKey, hiddenKey], pinnedThreadIds: ["mobile", "hidden"] });
    assert.deepEqual(pinned.pinnedThreadKeys, [threadKey]);
    assert.deepEqual(pinned.unpinnedThreadKeys, []);
    assert.deepEqual(visible({ get, threadKeys: [remoteKey, durableKey], pinnedThreadIds: [] }).allSidebarThreadKeys, [remoteKey],
      "The preserved durable Work filter does not apply to a connected remote core host");
  });

  await t.test("real project grouping matches nearest canonical root without boundary or case collisions", () => {
    const nested = [project("parent", "/home/repo"), project("nested", "/home/repo/pkg")];
    assert.deepEqual(matchingProject(nested, "/home/repo/pkg/src"), ["nested"]);
    assert.deepEqual(matchingProject(nested, "/home/repo/other"), ["parent"]);
    assert.deepEqual(matchingProject(nested, "/home/repository/src"), []);
    const caseSensitive = [project("upper", "/home/Repo"), project("lower", "/home/repo")];
    assert.deepEqual(matchingProject(caseSensitive, "/home/Repo/sub"), ["upper"]);
    assert.deepEqual(matchingProject(caseSensitive, "/home/repo/sub"), ["lower"]);
    assert.deepEqual(matchingProject(caseSensitive, "/home/REPO/sub"), []);
    const windows = [project("windows", "C:\\Work\\Repo", { rootPathAliases: [{ alias: "/mnt/c/work/repo", path: "C:\\Work\\Repo" }] })];
    for (const cwd of ["c:/work/repo/sub", "/mnt/c/WORK/Repo/sub", "/C:/Work/Repo/sub", "\\\\?\\C:\\WORK\\REPO\\sub"]) {
      assert.deepEqual(matchingProject(windows, cwd), ["windows"], cwd);
    }
    assert.deepEqual(matchingProject([project("unc", "\\\\Server\\Share\\Repo")], "//server/share/repo/sub"), ["unc"]);
    assert.deepEqual(matchingProject(nested, "/home/repo/pkg/src", { projectKind: "local", projectId: "unresolved-project" }), [],
      "Explicit unresolved assignment never falls back to an ancestor project");
    const scopeStart = patchedRenderer.indexOf("GT:function({projectId:e,");
    const scopeFilter = evaluate("", { czPathKey: visibility.pathKey, a: values => [...new Set(values.filter(Boolean))].sort(), o: value => `${value}/` },
      `(${patchedRenderer.slice(scopeStart + 3, blockEnd(patchedRenderer, patchedRenderer.indexOf("){", scopeStart) + 1))})`);
    const scope = (cwdValues, threadWorkspaceRootHints, extra = {}) => scopeFilter({ projectId: "repo", projectKind: "local",
      hostIds: ["local"], cwdValues, threadWorkspaceRootHints, projectlessThreadIds: [], threadProjectAssignments: {}, ...extra });
    assert.deepEqual(scope(["C:\\Work\\Repo"], { mobile: "/mnt/c/WORK/Repo" }).filter.includeThreadIds, ["mobile"]);
    assert.deepEqual(scope(["/home/Repo"], { upper: "/home/Repo", lower: "/home/repo" }).filter.includeThreadIds, ["upper"]);
    assert.deepEqual(scope(["/home/repo"], { upper: "/home/Repo", lower: "/home/repo" }).filter.includeThreadIds, ["lower"]);
    const mismatched = scope(["C:\\Work\\Repo"], { mobile: "/mnt/c/WORK/Repo" }, {
      threadProjectAssignments: { mobile: { projectKind: "local", projectId: "another-project" } } });
    assert.deepEqual(mismatched.filter.includeThreadIds, []);
    assert.deepEqual(mismatched.filter.excludeThreadIds, ["mobile"]);
  });
});
