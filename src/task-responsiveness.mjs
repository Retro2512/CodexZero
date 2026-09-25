import fs from "node:fs/promises";
import { replaceOnce } from "./sidebar-performance.mjs";
import { openAsar } from "./asar-patch.mjs";
import { patchSelectionScroll } from "./scroll-scope-performance.mjs";

export function patchTranscriptRetention(source) {
  let result = replaceOnce(source,
    'let r=t(oli,e),i=r.scope,a={materializedTurns:new Map};r.current=a;let o=new Map,s=new Set,c=!0,l=!1,u;',
    'let r=t(oli,e),i=r.scope,czEpoch=r.czRetentionEpoch=(r.czRetentionEpoch??0)+1,czRetained=czTranscriptRetention.take(i.node,e),a=czRetained?.a??{materializedTurns:new Map};r.current=a;let o=czRetained?.o??new Map,s=czRetained?.s??new Set,c=!0,l=!1,u;');
  result = replaceOnce(result,
    'if(t.type===`reset`){a.materializedTurns.clear();let n=t.value;if(n==null)return;',
    'if(t.type===`reset`){let n=t.value;if(n==null)return;czReconcileTurns(a.materializedTurns,n,t=>({details:i.get(eli,{...e,entityKey:t}),slots:o.get(t),itemKey:r=>vBt(t,r),item:r=>i.get(Qci,{...e,itemKey:vBt(t,r)})}),DI.default);');
  result = replaceOnce(result,
    'return()=>{c=!1,g(),a.materializedTurns.clear(),r.current===a&&(r.current=null,p(),queueMicrotask(()=>{r.current??m_t(i,EI(e))}))}},{autoDispose:!0}),jI=',
    'return()=>{c=!1,g();if(r.current!==a){a.materializedTurns.clear();return}r.current=null;let czDispose=()=>{if(r.current!=null||r.czRetentionEpoch!==czEpoch)return;a.materializedTurns.clear();p();queueMicrotask(()=>{r.current==null&&r.czRetentionEpoch===czEpoch&&m_t(i,EI(e))})};function*czRoots(){yield i.get(Zci,e);yield i.get(nli,e);yield i.get(rli,e);for(let[t,n]of o){yield t;yield n;yield i.get(eli,{...e,entityKey:t});for(let{itemId:r}of n.entries)yield i.get(Qci,{...e,itemKey:vBt(t,r)})}for(let t of s){yield t;yield i.get(OI,{...e,itemId:t})}for(let t of a.materializedTurns.values())yield t}let czParked=!1;if(l)try{czParked=czTranscriptRetention.park(i.node,e,{a,o,s},czRoots(),czDispose)}catch{}czParked||czDispose()}},{autoDispose:!0}),jI=');
  return 'import{transcriptRetention as czTranscriptRetention,reconcileMaterializedTurns as czReconcileTurns}from"./codexzero-transcript-retention.js";\n' + result;
}

export async function addTaskResponsiveness(replacements, archivePath) {
  const initial = [...replacements.keys()].find(name => /app-initial-.*\.js$/.test(name));
  if (!initial) throw new Error("Expected patched initial renderer");
  replacements.set(initial, Buffer.from(patchTranscriptRetention(replacements.get(initial).toString("utf8"))));
  replacements.set("webview/assets/codexzero-transcript-retention.js", await fs.readFile(new URL("../assets/transcript-retention.mjs", import.meta.url)));
  const archive = await openAsar(archivePath);
  try {
    const names = Object.keys(archive.header.files.webview.files.assets.files).filter(name => /^app-primary-.*\.js$/.test(name));
    if (names.length !== 1) throw new Error("Expected one primary renderer bundle");
    const name = `webview/assets/${names[0]}`;
    replacements.set(name, Buffer.from(patchSelectionScroll((await archive.read(name)).toString("utf8"))));
  } finally { await archive.close(); }
  const identity = ".vite/build/codexzero-identity.cjs";
  replacements.set(identity, Buffer.from(replacements.get(identity).toString("utf8")
    .replaceAll('"CodexZero.PerformancePreview"', '"CodexZero.ResponsivenessPreview"')
    .replaceAll('"CodexZero Preview"', '"CodexZero Preview 2"')));
}

