// Starts loading a thread while the pointer rests on its sidebar row, so the
// click finds it ready. Uses the same path as the app's own background loads
// (scheduled tasks), with strict limits so scrolling the sidebar stays cheap.

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`This Codex version needs an updated thread preload patch: ${before.slice(0, 60)}`);
  return source.replace(before, () => after);
}

// Every internal this relies on must still exist under the same name.
const requiredAnchors = [
  "async function Imn(e,t,{allowProjectSourceRoots:n=!1}={})",
  "function ep(e,t){let n=e.get(tp);",
  "function Mb(e,t){return async(",
  "function P_(e,t){let n=e.get(F_);return n!=null&&n.checkGate(t)}",
  ",KE=uf($,(e,{get:t})=>t(t(d5n,e))!=null)",
  ",QE=zE(({resumeState:e})=>e)",
  ",t5n=uf($,(e,{get:t})=>{if(e==null)return null;",
  ",XE=zE(({latestCollaborationMode:e})=>e,",
];

export const preloadRuntime = String.raw`let czPreloadScope=null;const czPreloadBusy=new Set,czPreloadTried=new Map;
function czRememberPreloadScope(e){czPreloadScope=e;return e}
async function czPreloadThread(id,hostId){
let e=czPreloadScope;if(e==null||typeof id!=="string"||!id)return!1;
let now=Date.now(),last=czPreloadTried.get(id);if(last!=null&&now-last<3e4)return!1;
if(czPreloadBusy.has(id)||czPreloadBusy.size>=2)return!1;
try{let has=e.get(KE,id),state=e.get(QE,id),role=e.get(t5n,id);if(state===` + "`resuming`" + String.raw`||has&&state!==` + "`needs_resume`" + String.raw`&&role!=null)return!1}catch{return!1}
czPreloadBusy.add(id);czPreloadTried.set(id,now);if(czPreloadTried.size>200)czPreloadTried.delete(czPreloadTried.keys().next().value);
let host=hostId||` + "`local`" + String.raw`;if(host!==` + "`local`" + String.raw`){czPreloadBusy.delete(id);return!1}
try{let roots=await Promise.race([Imn(e,id,{allowProjectSourceRoots:!0}),new Promise(r=>setTimeout(()=>r(null),2e3))]);if(roots==null)return!1;
let result=await ep(e,host).resumeConversation({conversationId:id,model:null,reasoningEffort:null,workspaceRoots:roots,useAppServerPermissionDefault:P_(e,` + "`4226282475`" + String.raw`),collaborationMode:e.get(XE,id)??null,showThreadGoalResumeConfirmation:!1},{readResumeInputs:Mb(e,host)});return result?.status===` + "`ready`" + String.raw`}catch{return!1}finally{czPreloadBusy.delete(id)}}
globalThis.codexZeroPreloadThread=czPreloadThread;
`;

export function patchThreadPreload(source) {
  for (const anchor of requiredAnchors) {
    if (source.split(anchor).length !== 2) throw new Error(`This Codex version needs an updated thread preload patch: ${anchor.slice(0, 60)}`);
  }
  const result = replaceOnce(source, "T=xf($),E=vf(bK)===`work`,D=bf(Kwi,n)", "T=czRememberPreloadScope(xf($)),E=vf(bK)===`work`,D=bf(Kwi,n)");
  return preloadRuntime + result;
}
