// Starts loading a thread while the pointer rests on its sidebar row, so the
// click finds it ready. Uses the same resume path as the app's own thread
// actions, with strict limits so scrolling the sidebar stays cheap.
export const THREAD_PRELOAD_TARGET = '"2337831332"';

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`This Codex version needs an updated thread preload patch: ${before.slice(0, 60)}`);
  return source.replace(before, () => after);
}

// The sidebar row module hands over the app scope and the module loader. The
// internals are core app modules: workspace roots (MLeN), app-server client
// (Dgwo), feature gates (OMIV), thread atoms (tl5a), and resume inputs (shRG).
export const preloadRuntime = String.raw`let czPreloadScope=null,czPreloadRequire=null;const czPreloadBusy=new Set,czPreloadTried=new Map;
function czRememberPreloadScope(e){czPreloadScope=e;return e}
async function czPreloadThread(id,hostId){
let e=czPreloadScope,r=czPreloadRequire;if(e==null||r==null||typeof id!=="string"||!id)return!1;
let now=Date.now(),last=czPreloadTried.get(id);if(last!=null&&now-last<3e4)return!1;
if(czPreloadBusy.has(id)||czPreloadBusy.size>=2)return!1;
let host=hostId||"local";if(host!=="local")return!1;
czPreloadBusy.add(id);czPreloadTried.set(id,now);if(czPreloadTried.size>200)czPreloadTried.delete(czPreloadTried.keys().next().value);
try{let roots=await Promise.race([r("MLeN").A(e,id,{allowProjectSourceRoots:!0}),new Promise(t=>setTimeout(()=>t(null),2e3))]);if(roots==null)return!1;
let result=await r("Dgwo").V(e,host).resumeConversation({conversationId:id,model:null,reasoningEffort:null,workspaceRoots:roots,useAppServerPermissionDefault:r("OMIV").ie(e,"4226282475"),collaborationMode:e.get(r("tl5a").aG,id)??null,showThreadGoalResumeConfirmation:!1},{readResumeInputs:r("shRG").jQ(e,host)});return result?.status==="ready"}catch{return!1}finally{czPreloadBusy.delete(id)}}
globalThis.codexZeroPreloadThread=czPreloadThread;
`;

export function patchThreadPreload(source) {
  let result = replaceOnce(source, ",oprL(e,t,a){a.d(t,{E:()=>e_,T:()=>eR});", ",oprL(e,t,a){a.d(t,{E:()=>e_,T:()=>eR});czPreloadRequire=a;");
  result = replaceOnce(result, "tp=(0,i.gh)(F.u),{previewNavigationState:tf}", "tp=czRememberPreloadScope((0,i.gh)(F.u)),{previewNavigationState:tf}");
  return preloadRuntime + result;
}
