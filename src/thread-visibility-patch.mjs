import { createRequire } from "node:module";
import { replaceOnce } from "./sidebar-performance.mjs";

const { pathKey, pathSql, findPathGroup, applyObservation, observedActivity } = createRequire(import.meta.url)("../assets/native-sidebar-threads.cjs");

export const THREAD_VISIBILITY_MAIN_TARGET = "Unknown thread catalog host: ";
export const THREAD_VISIBILITY_RENDERER_TARGET = "No original clone cwd found for pending worktree task";

// «name» captures one minified name or member path, so a shape fits every
// platform build; a repeated «name» must repeat the same text.
export function matchShape(source, shape) {
  const names = new Set();
  const pattern = shape.split(/«(\w+)»/).map((part, index) => index % 2 === 0 ? part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : names.has(part) ? `\\k<${part}>` : (names.add(part), `(?<${part}>[\\w$]+(?:\\.[\\w$]+)*)`)).join("");
  const guard = /^[\w$«]/.test(shape) ? "(?<![\\w$.])" : "";
  const matches = [...source.matchAll(new RegExp(guard + pattern, "g"))];
  if (matches.length !== 1) throw new Error(`Unsupported bundle anchor (${matches.length} matches): ${shape.slice(0, 90)}`);
  return matches[0];
}
export function replaceShape(source, shape, after) {
  const match = matchShape(source, shape);
  return source.slice(0, match.index) + after.replace(/«(\w+)»/g, (_, name) => match.groups[name]) + source.slice(match.index + match[0].length);
}

export function patchThreadVisibilityMain(source) {
  source = patchRecencyFallback(source);
  // The catalog refreshes metadata for tasks that may already have a live
  // conversation. Updating only their titles leaves live sort atoms stale.
  source = replaceShape(source, 'Object.assign(e,«metadata»(t,e,"stored")),null!=l&&(e.title=l)',
    'Object.assign(e,«metadata»(t,e,"stored")),czThreadVisibility.applyObservation(e,t),null!=l&&(e.title=l)');
  source = replaceOnce(source, "return null==a.originator&&null!=e.originator&&(a={...a,originator:e.originator}),{thread:a,clearCachedTitles:s}}",
    "return a=czThreadVisibility.observedActivity(a,e),null==a.originator&&null!=e.originator&&(a={...a,originator:e.originator}),{thread:a,clearCachedTitles:s}}");
  let result = replaceShape(source, 'function «source»(e,t,r){return{id:e,hostKind:t,listPage:async({cursor:t,limit:n},i)=>{let s=await r.listThreads({archived:!1,cursor:t,limit:n,modelProviders:[],parentThreadId:null,sortKey:"updated_at",sortDirection:"desc",sourceKinds:«kinds»,useStateDbOnly:!0},{...i,source:"thread_catalog"});',
    'function «source»(e,t,r){let czList=czThreadVisibility.createListing((e,t)=>r.listThreads(e,t),e,«kinds»);return{id:e,hostKind:t,listPage:async({cursor:t,limit:n},i)=>{let s=await czList({cursor:t,limit:n},{...i,source:"thread_catalog"});');
  result = replaceOnce(result, "isFullReconciliationDue(e){return!e.isComplete||null==e.lastFullReconciliationAt}",
    "isFullReconciliationDue(e){return czThreadVisibility.needsFullScan(e,this.store.hostKind,this.now())}");
  result = replaceOnce(result, "this.fullReconciliationDue=this.isFullReconciliationDue(this.store.readSyncState()),this.requestRun(",
    'this.fullReconciliationDue="chatgpt"!==this.store.hostKind||this.isFullReconciliationDue(this.store.readSyncState()),this.requestRun(');
  result = replaceOnce(result, 'let s=e??(this.store.readSyncState().isComplete?"incremental":"full");',
    'let s=e??(this.isFullReconciliationDue(this.store.readSyncState())?"full":"incremental");"full"===s&&(this.fullReconciliationDue=!0);');
  result = replaceOnce(result, "if(!t&&null!=this.lastSuccessAt&&n-this.lastSuccessAt<(this.options.successFreshnessMs??3e4))",
    "if(!t&&!this.isFullReconciliationDue(this.store.readSyncState())&&null!=this.lastSuccessAt&&n-this.lastSuccessAt<(this.options.successFreshnessMs??3e4))");
  result = replaceOnce(result, "if(this.syncEnabled=e,e)return void this.handleImportedThreads(",
    "if(this.syncEnabled=e,czThreadVisibility.setPolling(this,e),e)return void this.handleImportedThreads(");
  result = replaceOnce(result, "this.disposed||(this.disposed=!0,null!=this.historyPruneTimer&&clearInterval(this.historyPruneTimer)",
    "this.disposed||(this.disposed=!0,czThreadVisibility.setPolling(this,!1),null!=this.historyPruneTimer&&clearInterval(this.historyPruneTimer)");
  result = replaceOnce(result, 'if(this.syncEnabled||"externalAgentConfig/import/completed"===e.method)switch(e.method)',
    'if(this.syncEnabled||"thread/started"===e.method||"externalAgentConfig/import/completed"===e.method)switch(e.method)');
  result = replaceOnce(result, 'case"thread/name/updated":case"thread/unarchived":case"turn/completed":{',
    'case"thread/status/changed":czThreadVisibility.refreshActivity(this,t);return;case"turn/started":case"thread/name/updated":case"thread/unarchived":case"turn/completed":{');

  // Canonicalize comparisons and index expressions, never the stored cwd.
  const start = result.indexOf("readPage({limit:e,cursor:t,filter:r,manualOrder:n,sortKey:i}){");
  const end = result.indexOf("readScanCheckpoint(){", start);
  if (start < 0 || end < start) throw new Error("Unsupported thread catalog path query");
  let queries = result.slice(start, end).replace(/\b(catalog\.)?cwd\b/g, (_, alias = "") => pathSql(alias + "cwd"));
  queries = replaceOnce(queries, "readPage({limit:e,cursor:t,filter:r,manualOrder:n,sortKey:i}){", "readPage({limit:e,cursor:t,filter:r,manualOrder:n,sortKey:i}){czThreadVisibility.ensurePathIndexes(this.db);");
  queries = replaceOnce(queries, "readManualPage(e,t,r){", "readManualPage(e,t,r){czThreadVisibility.ensurePathIndexes(this.db);");
  for (const [before, after] of [
    ["local_thread_catalog_cwd_created_idx", "cz_thread_catalog_path_created_idx"],
    ["local_thread_catalog_cwd_updated_idx", "cz_thread_catalog_path_recent_idx"],
    ["JSON.stringify(r.cwdValues)", "JSON.stringify(czThreadVisibility.pathValues(r.cwdValues))"],
    ["JSON.stringify(t.cwdValues)", "JSON.stringify(czThreadVisibility.pathValues(t.cwdValues))"],
  ]) queries = replaceOnce(queries, before, after);
  for (const filter of ["r", "t"]) queries = replaceShape(queries, `JSON.stringify(«prefixes»(${filter}.cwdPrefixes))`, `JSON.stringify(czThreadVisibility.pathPrefixes(${filter}.cwdPrefixes))`);
  result = result.slice(0, start) + queries + result.slice(end);

  // Native membership support is negotiated by the backend. The account gate
  // must not disable ingestion of projects or memberships created by mobile.
  result = replaceShape(result, '()=>e.windowManager.sendMessageToAllWindows({type:"global-state-updated",keys:[«keys».LOCAL_PROJECTS]})),Z=()=>{«backend».setThreadAssignmentsEnabled(«features»().localProjectTaskMembership)}',
    '()=>{e.windowManager.sendMessageToAllWindows({type:"global-state-updated",keys:[«keys».LOCAL_PROJECTS]}),e.windowManager.sendMessageToAllWindows({type:"workspace-root-options-updated"})}),Z=()=>{«backend».setThreadAssignmentsEnabled(!0)}');
  // Initial import can seed old, unassigned rollouts, but must not overwrite a
  // project selected on mobile. Explicit queued desktop edits still replay.
  result = replaceOnce(result, "n.pendingThreadAssignmentIds?.includes(e.id))&&await this.syncAssignment(e.id,e.projectId,t),await this.observe(e.id,e.projectId,t)",
    "n.pendingThreadAssignmentIds?.includes(e.id))&&(e.projectId==null||n?.pendingThreadAssignmentIds?.includes(e.id))&&await this.syncAssignment(e.id,e.projectId,t),await this.observe(e.id,e.projectId,t)");
  result = replaceShape(result, "await e,t.throwIfAborted();let s=this.globalState.get(«keys».APP_SERVER_PROJECTS_MIGRATION_BY_HOST)",
    "await e,t.throwIfAborted();await czThreadVisibility.refreshUnknownProject(this,n,t);let s=this.globalState.get(«keys».APP_SERVER_PROJECTS_MIGRATION_BY_HOST)");
  result = replaceOnce(result, "this.legacyProjectIdsByServerId.set(e.id,r),this.serverProjectsByLegacyId.set(r,e);",
    "this.legacyProjectIdsByServerId.set(e.id,r),this.serverProjectsByLegacyId.set(r,e);czThreadVisibility.mirrorProject(this,e,r);");
  return 'const czThreadVisibility=require("./native-sidebar-threads.cjs");\n' + result;
}

export function patchThreadVisibilityRenderer(source) {
  let result = patchRecencyFallback(source);
  result = replaceOnce(result, 'function C(e){let t=e.filter(e=>"local"===e.projectKind),n=new Set(t.flatMap(e=>(0,c.l_)(e).map(g.JH))),r=new Map;',
    'function C(e){let t=e.filter(e=>"local"===e.projectKind),n=new Set(t.flatMap(e=>(0,c.l_)(e).map(czPathKey))),r=new Map;');
  result = replaceOnce(result, ".filter(({alias:e})=>!n.has((0,g.JH)(e)))]){let n=(0,g.JH)(t),i=e.path===o",
    ".filter(({alias:e})=>!n.has(czPathKey(e)))]){let n=czPathKey(t),i=e.path===o");
  result = replaceOnce(result, "function S(e,t){return e.get((0,g.JH)(t))??null}", "function S(e,t){return czFindPathGroup(e,czPathKey(t))}");
  result = replaceOnce(result, "if(r.has((0,g.JH)(e)))return null;", "if(r.has(czPathKey(e)))return null;");
  result = replaceOnce(result, ".filter(e=>a.get((0,C.JH)(e))?.projectId===n.projectId)", ".filter(e=>a.get(czPathKey(e))?.projectId===n.projectId)");
  result = replaceOnce(result, "f=new Set(h.map(i.JH)),m=new Set,_=new Set(s??[]),g=u??{};for(let e of Object.keys(g))f.has((0,i.JH)(g[e]))&&m.add(e);",
    "f=new Set(h.map(czPathKey)),m=new Set,_=new Set(s??[]),g=u??{};for(let e of Object.keys(g))f.has(czPathKey(g[e]))&&m.add(e);");
  result = replaceOnce(result, 'if(f?.projectKind==="local"&&"chatgpt"===f.projectOrigin)return;let _=e.cwd;', "if(null!=f)return;let _=e.cwd;");
  // Missing project metadata is not evidence that a task was deleted. Retain
  // unresolved assignments in Recents and Pinned without guessing a project.
  result = replaceOnce(result, 'if(function(e,t){if(!e(l.Mo,s.Q2Y.LOCAL_PROJECTS).isSuccess)return!1;let n=b(e,t);if(null==n)return!1;let r=n.reference.threadId,i=null==r?n.pendingProjectAssignment:(0,l.F6)(e,s.Q2Y.THREAD_PROJECT_ASSIGNMENTS)?.[r];return i?.projectKind==="local"&&"chatgpt"!==i.projectOrigin&&(0,l.F6)(e,s.Q2Y.LOCAL_PROJECTS)?.[i.projectId]==null&&e(g.T8,t)?.projectKind!=="local"}(e,t))return!1;let c=b(e,t)?.identity;',
    "let c=b(e,t)?.identity;");
  result = replaceShape(result, 'Object.assign(e,«metadata»(t,e,"stored")),null!=l&&(e.title=l)',
    'Object.assign(e,«metadata»(t,e,"stored")),czObserveThread(e,t),null!=l&&(e.title=l)');
  result = replaceOnce(result, "return null==s.originator&&null!=e.originator&&(s={...s,originator:e.originator}),{thread:s,clearCachedTitles:a}}",
    "return s=czObservedActivity(s,e),null==s.originator&&null!=e.originator&&(s={...s,originator:e.originator}),{thread:s,clearCachedTitles:a}}");
  return `const czObserveThread=${applyObservation.toString()},czObservedActivity=${observedActivity.toString()},czPathKey=${pathKey.toString()},czFindPathGroup=${findPathGroup.toString()};\n` + result;
}

function patchRecencyFallback(source) {
  return replaceShape(source, "function «name»({currentRecencyAt:e,threadRecencyAt:t,updatedAt:«updated»}){return null==t?e??«updated»:Math.max(e??t,t)}",
    "function «name»({currentRecencyAt:e,threadRecencyAt:t,updatedAt:«updated»}){let czRecency=Number.isFinite(t)?t:«updated»;return Number.isFinite(e)?Number.isFinite(czRecency)?Math.max(e,czRecency):e:czRecency}");
}
