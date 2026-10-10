import { createRequire } from "node:module";
import { replaceOnce } from "./sidebar-performance.mjs";

const { pathKey, pathSql, findPathGroup, applyObservation, observedActivity } = createRequire(import.meta.url)("../assets/native-sidebar-threads.cjs");

export function patchThreadVisibilityMain(source) {
  source = patchRecencyFallback(source, "Ay");
  // The catalog refreshes metadata for tasks that may already have a live
  // conversation. Updating only their titles leaves live sort atoms stale.
  source = replaceOnce(source, "Object.assign(e,jy(s,e,`stored`)),c!=null&&(e.title=c)",
    "Object.assign(e,jy(s,e,`stored`)),czThreadVisibility.applyObservation(e,s),c!=null&&(e.title=c)");
  source = replaceOnce(source, "o.originator==null&&r.originator!=null&&(o={...o,originator:r.originator});let s=this.applyPendingThreadTitle",
    "o=czThreadVisibility.observedActivity(o,r);o.originator==null&&r.originator!=null&&(o={...o,originator:r.originator});let s=this.applyPendingThreadTitle");
  let result = replaceOnce(source, "function M5(e,t,r){return{id:e,hostKind:t,listPage:async({cursor:t,limit:i},a)=>{let o=await r.listThreads({archived:!1,cursor:t,limit:i,modelProviders:[],parentThreadId:null,sortKey:`updated_at`,sortDirection:`desc`,sourceKinds:n.na,useStateDbOnly:!0},{...a,source:`thread_catalog`});",
    "function M5(e,t,r){let czList=czThreadVisibility.createListing((e,t)=>r.listThreads(e,t),e,n.na);return{id:e,hostKind:t,listPage:async({cursor:t,limit:i},a)=>{let o=await czList({cursor:t,limit:i},{...a,source:`thread_catalog`});");
  result = replaceOnce(result, "isFullReconciliationDue(e){return!e.isComplete||e.lastFullReconciliationAt==null}",
    "isFullReconciliationDue(e){return czThreadVisibility.needsFullScan(e,this.store.hostKind,this.now())}");
  result = replaceOnce(result, "this.fullReconciliationDue=this.isFullReconciliationDue(this.store.readSyncState()),this.requestRun(",
    "this.fullReconciliationDue=this.store.hostKind!==`chatgpt`||this.isFullReconciliationDue(this.store.readSyncState()),this.requestRun(");
  result = replaceOnce(result, "let a=e??(this.store.readSyncState().isComplete?`incremental`:`full`);",
    "let a=e??(this.isFullReconciliationDue(this.store.readSyncState())?`full`:`incremental`);a===`full`&&(this.fullReconciliationDue=!0);");
  result = replaceOnce(result, "if(!t&&this.lastSuccessAt!=null&&r-this.lastSuccessAt<(this.options.successFreshnessMs??Mtt))",
    "if(!t&&!this.isFullReconciliationDue(this.store.readSyncState())&&this.lastSuccessAt!=null&&r-this.lastSuccessAt<(this.options.successFreshnessMs??Mtt))");
  result = replaceOnce(result, "if(this.syncEnabled=e,e){this.handleImportedThreads(",
    "if(this.syncEnabled=e,czThreadVisibility.setPolling(this,e),e){this.handleImportedThreads(");
  result = replaceOnce(result, "this.disposed=!0,this.historyPruneTimer!=null&&clearInterval(this.historyPruneTimer)",
    "this.disposed=!0,czThreadVisibility.setPolling(this,!1),this.historyPruneTimer!=null&&clearInterval(this.historyPruneTimer)");
  result = replaceOnce(result, "if(this.syncEnabled||e.method===`externalAgentConfig/import/completed`)switch(e.method)",
    "if(this.syncEnabled||e.method===`thread/started`||e.method===`externalAgentConfig/import/completed`)switch(e.method)");
  result = replaceOnce(result, "case`turn/completed`:this.invalidateSource();return;default:return}}removeThreadFromCatalog",
    "case`turn/started`:case`turn/completed`:czThreadVisibility.refreshActivity(this,t);this.invalidateSource();return;case`thread/status/changed`:czThreadVisibility.refreshActivity(this,t);return;default:return}}removeThreadFromCatalog");

  // Canonicalize comparisons and index expressions, never the stored cwd.
  const start = result.indexOf("readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){");
  const end = result.indexOf("readScanCheckpoint(){", start);
  if (start < 0 || end < start) throw new Error("Unsupported thread catalog path query");
  const before = result.slice(start, end);
  let queries = before.replace(/\b(catalog\.)?cwd\b/g, (_, alias = "") => pathSql(alias + "cwd"));
  queries = replaceOnce(queries, "readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){", "readPage({limit:e,cursor:t,filter:n,manualOrder:r,sortKey:i}){czThreadVisibility.ensurePathIndexes(this.db);");
  queries = replaceOnce(queries, "readManualPage(e,t,n){", "readManualPage(e,t,n){czThreadVisibility.ensurePathIndexes(this.db);");
  queries = queries.replaceAll("local_thread_catalog_cwd_created_idx", "cz_thread_catalog_path_created_idx")
    .replaceAll("local_thread_catalog_cwd_updated_idx", "cz_thread_catalog_path_recent_idx")
    .replaceAll("JSON.stringify(n.cwdValues)", "JSON.stringify(czThreadVisibility.pathValues(n.cwdValues))")
    .replaceAll("JSON.stringify(t.cwdValues)", "JSON.stringify(czThreadVisibility.pathValues(t.cwdValues))")
    .replaceAll("JSON.stringify(Hh(n.cwdPrefixes))", "JSON.stringify(czThreadVisibility.pathPrefixes(n.cwdPrefixes))")
    .replaceAll("JSON.stringify(Hh(t.cwdPrefixes))", "JSON.stringify(czThreadVisibility.pathPrefixes(t.cwdPrefixes))");
  result = result.slice(0, start) + queries + result.slice(end);

  // Native membership support is negotiated by the backend. The account gate
  // must not disable ingestion of projects or memberships created by mobile.
  result = replaceOnce(result, "constructor(e,t,n,r=()=>{}){this.globalState=e,this.connection=t,this.cache=n,",
    "constructor(e,t,n,r=()=>{},czProjectChanged=()=>{}){this.czProjectChanged=czProjectChanged,this.globalState=e,this.connection=t,this.cache=n,");
  result = replaceOnce(result, "new P6e(this.scopedState,r,new m2(this.scopedState),t=>e.windowManager.sendMessageToAllWindows({type:`thread-project-memberships-updated`,memberships:t}))",
    "new P6e(this.scopedState,r,new m2(this.scopedState),t=>e.windowManager.sendMessageToAllWindows({type:`thread-project-memberships-updated`,memberships:t}),()=>{e.windowManager.sendMessageToAllWindows({type:`global-state-updated`,keys:[n.Hl.LOCAL_PROJECTS]});e.windowManager.sendMessageToAllWindows({type:`workspace-root-options-updated`})})");
  result = replaceOnce(result, "c.setThreadAssignmentsEnabled(Cr().localProjectTaskMembership)", "c.setThreadAssignmentsEnabled(!0)");
  // Initial import can seed old, unassigned rollouts, but must not overwrite a
  // project selected on mobile. Explicit queued desktop edits still replay.
  result = replaceOnce(result, "&&await this.syncAssignment(e.id,e.projectId,t),await this.observe(e.id,e.projectId,t)",
    "&&(e.projectId==null||i?.pendingThreadAssignmentIds?.includes(e.id))&&await this.syncAssignment(e.id,e.projectId,t),await this.observe(e.id,e.projectId,t)");
  result = replaceOnce(result, "await e,t.throwIfAborted();let o=this.globalState.get(n.Hl.APP_SERVER_PROJECTS_MIGRATION_BY_HOST)",
    "await e,t.throwIfAborted();await czThreadVisibility.refreshUnknownProject(this,i,t);let o=this.globalState.get(n.Hl.APP_SERVER_PROJECTS_MIGRATION_BY_HOST)");
  result = replaceOnce(result, "this.legacyProjectIdsByServerId.set(e.id,r),this.serverProjectsByLegacyId.set(r,e)}projectMetadata",
    "this.legacyProjectIdsByServerId.set(e.id,r),this.serverProjectsByLegacyId.set(r,e),czThreadVisibility.mirrorProject(this,e,r)}projectMetadata");
  return 'const czThreadVisibility=require("./native-sidebar-threads.cjs");\n' + result;
}

export function patchThreadVisibilityRenderer(source) {
  let result = patchRecencyFallback(source, "ch");
  result = replaceOnce(result, "function fni(e){let t=e.filter(e=>e.projectKind===`local`),n=new Set(t.flatMap(e=>bF(e).map(on))),r=new Map;for(let e of t){let t=[...bF(e).map(e=>({alias:e,path:e})),...gni(e).filter(({alias:e})=>!n.has(on(e)))];for(let{alias:n,path:i}of t){let t=on(n),",
    "function fni(e){let t=e.filter(e=>e.projectKind===`local`),n=new Set(t.flatMap(e=>bF(e).map(czPathKey))),r=new Map;for(let e of t){let t=[...bF(e).map(e=>({alias:e,path:e})),...gni(e).filter(({alias:e})=>!n.has(czPathKey(e)))];for(let{alias:n,path:i}of t){let t=czPathKey(n),");
  result = replaceOnce(result, "function Sni(e,t){return e.get(on(t))??null}function Cni(e,t){return e.has(on(t))}",
    "function Sni(e,t){return czFindPathGroup(e,czPathKey(t))}function Cni(e,t){return e.has(czPathKey(t))}");
  result = replaceOnce(result, ".filter(t=>n.get(on(t))?.projectId===e.projectId)",
    ".filter(t=>n.get(czPathKey(t))?.projectId===e.projectId)");
  result = replaceOnce(result, "let u=Hti(r),d=new Set(u.map(on)),f=new Set,p=new Set(i??[]);for(let[e,t]of Object.entries(o??{}))d.has(on(t))&&f.add(e);",
    "let u=Hti(r),d=new Set(u.map(czPathKey)),f=new Set,p=new Set(i??[]);for(let[e,t]of Object.entries(o??{}))d.has(czPathKey(t))&&f.add(e);");
  result = replaceOnce(result, "if(l?.projectKind===`local`&&l.projectOrigin===`chatgpt`)return;let d=e.cwd;", "if(l!=null)return;let d=e.cwd;");
  // Missing project metadata is not evidence that a task was deleted. Retain
  // unresolved assignments in Recents and Pinned without guessing a project.
  result = replaceOnce(result, "if(e(Osi,t))return!1;let n=e(JF,t);", "let n=e(JF,t);");
  result = replaceOnce(result, "Object.assign(e,lh(o,e,`stored`)),s!=null&&(e.title=s)",
    "Object.assign(e,lh(o,e,`stored`)),czObserveThread(e,o),s!=null&&(e.title=s)");
  result = replaceOnce(result, "a.originator==null&&n.originator!=null&&(a={...a,originator:n.originator});let o=this.applyPendingThreadTitle",
    "a=czObservedActivity(a,n);a.originator==null&&n.originator!=null&&(a={...a,originator:n.originator});let o=this.applyPendingThreadTitle");
  return `const czObserveThread=${applyObservation.toString()},czObservedActivity=${observedActivity.toString()},czPathKey=${pathKey.toString()},czFindPathGroup=${findPathGroup.toString()};\n` + result;
}

function patchRecencyFallback(source, name) {
  return replaceOnce(source, `function ${name}({currentRecencyAt:e,threadRecencyAt:t,updatedAt:n}){return t==null?e??n:Math.max(e??t,t)}`,
    `function ${name}({currentRecencyAt:e,threadRecencyAt:t,updatedAt:n}){let r=Number.isFinite(t)?t:n;return Number.isFinite(e)?Number.isFinite(r)?Math.max(e,r):e:r}`);
}
