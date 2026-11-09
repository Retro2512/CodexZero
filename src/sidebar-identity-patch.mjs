import fs from "node:fs/promises";
import { locateTargets, openAsar } from "./asar-patch.mjs";
import { matchShape, replaceShape } from "./thread-visibility-patch.mjs";

export const SIDEBAR_IDENTITY_MAIN_TARGET='feature:"thread_title"';
export const SIDEBAR_IDENTITY_PROJECTS_TARGET='"data-sidebar-project-drop-zone":';
export const SIDEBAR_IDENTITY_THREADS_TARGET='source:"sidebar_context_menu"';
export const SIDEBAR_IDENTITY_PROJECT_EDITOR_TARGET='id:"projectSetup.projectNameInput.nameLabel"';

function once(source,before,after){if(source.split(before).length!==2)throw new Error(`Unsupported appearance patch anchor: ${before.slice(0,80)}`);return source.replace(before,()=>after);}
// Bundled components reach React through their module's require function.
function withReact(source,id,vars=""){const match=[...source.matchAll(new RegExp(`(?<![\\w$])${id}\\((\\w+),(\\w+),(\\w+)\\)\\{`,"g"))];if(match.length!==1)throw new Error(`Missing appearance component ${id}`);const end=match[0].index+match[0][0].length;return source.slice(0,end)+`var czReact=${match[0][3]}("zd8w")${vars};`+source.slice(end);}
const runtime=names=>`import{${names}}from"../codexzero-sidebar-identity.js";\n`;

export function patchIdentityProjects(source){
  let s=withReact(withReact(source,"anBE"),"qNX8");
  // Native elements retain their refs, drag listeners, semantics and memoized children.
  s=once(s,"G[139]=F):F=G[139],F}function tp(e){","G[139]=F):F=G[139],czProjectElement(czReact,W,F)}function tp(e){");
  s=once(s,"children:l}),C[21]=l,","children:czProjectIcon(czReact,h,l)}),C[21]=l,");
  return runtime("projectElement as czProjectElement,projectIcon as czProjectIcon")+s;
}
export function patchIdentityThreads(source){
  let s=withReact(source,"oprL",",czThreadDialog");
  s=once(s,"function e_(e){let t,a=(0,o.c)(2);","function e_(e){return czThreadElement(czReact,czNativeThread,e)}function czNativeThread(e){let t,a=(0,o.c)(2);");
  // Preserve native title saving and wrap Save with dirty appearance persistence.
  s=once(s,'(0,w.qf)(tp,el.SidebarRenameDialog,{messages:eY?B.K:void 0,draftKey:eG,',
    '(0,w.qf)(tp,czThreadDialog??=e=>czEditorSession(czReact,e,el.SidebarRenameDialog),{czKind:"thread",czId:eG,czHostId:tm?.hostId,messages:eY?B.K:{title:{id:"codexzero.editTaskTitle",defaultMessage:"Edit task"},subtitle:{id:"codexzero.editTaskAppearance",defaultMessage:"{czEditor}"},placeholder:{id:"sidebarElectron.renameThreadDialogPlaceholder",defaultMessage:"Add a title…"},ariaLabel:{id:"sidebarElectron.renameThreadDialogAriaLabel",defaultMessage:"Chat title"},values:{czEditor:czEditorElement(czReact,{kind:"thread",id:eG,hostId:tm?.hostId,title:tz??""})}},draftKey:eG,');
  return runtime("threadElement as czThreadElement,editorSession as czEditorSession,editorElement as czEditorElement")+s;
}
export function patchIdentityProjectEditor(source){
  let s=withReact(source,"pki7");
  s=once(s,"function R(e){let t,r,o,a,n,c,d,h,m,y,w,S,A,P,I,M,T,N,_,R,O,z=(0,s.c)(79),",
    'function R(e){return czEditorSession(czReact,{...e,czKind:"project",czId:e.projectId},czNativeProjectDialog)}function czNativeProjectDialog(e){let t,r,o,a,n,c,d,h,m,y,w,S,A,P,I,M,T,N,_,R,O,z=(0,s.c)(79),');
  s=once(s,'children:[d,m,y]}),z[41]=en,','children:[d,m,czEditorElement(czReact,{kind:"project",id:Y,title:ee}),y]}),z[41]=en,');
  // The native project marker picker otherwise competes with this store.
  s=once(s,"E=(0,l.useId)(),N=null!=A||null!=w;","E=(0,l.useId)(),N=null==A&&null!=w;");
  return runtime("editorSession as czEditorSession,editorElement as czEditorElement")+s;
}
const bridge='require("./codexzero-sidebar-appearance-main.cjs")';
// Native structured generation reuses the selected provider/auth path. No shell, plugins or tools.
const generator=(generate,base)=>`czOptions=>${generate}({...czOptions,cwd:null,serviceTier:null,effort:"low",threadSource:"appearance",client:this,timeoutMs:45000,baseInstructions:"Return the requested JSON only. Do not call tools or inspect files.",config:{...${base},"features.hooks":!1},responseSchema:{safeParse:value=>({success:!0,data:value})},allowProviderModelFallback:!1})`;
export function patchIdentityMain(source){
  const register=generator(matchShape(source,"async function «generate»({prompt:e,imageUrls:t,cwd:n,model:r,modelProvider:i=null,").groups.generate,matchShape(source,"let «base»={include_permissions_instructions:!1,").groups.base);
  let s=once(source,'async listThreads(e,t,n){let r=',`async listThreads(e,t,n){${bridge}.register(this,${register});let r=`);
  s=once(s,'async startTurn(e,t,n){var r,i,a;if(null==t){',`async startTurn(e,t,n){var r,i,a;${bridge}.register(this,${register},e);if(null==t){`);
  s=once(s,'let s=a.result;return!0===e.ephemeral&&this.markEphemeralThread(s.thread.id),s}',`let s=a.result;return!0===e.ephemeral&&this.markEphemeralThread(s.thread.id),${bridge}.created(this,s,e),s}`);
  s=once(s,'this.broadcastThreadTitleUpdated(e,i,n))}',`this.broadcastThreadTitleUpdated(e,i,n),${bridge}.titleUpdated(this,e,i))}`);
  s=replaceShape(s,'y=await «structured»({appServerClient:i,model:f,readOnlyAppToolAllowlist:u,cwd:n,fallbackToFreshThread:!c&&l,feature:"thread_title",experimentalPredictionMode:c,outputSchema:c?null:«schema»(g),prompt:m,responseSchema:g,',
    `czIdentity=c?null:await ${bridge}.prepare(i,o,n),czSchema=c?null:«schema»(g);czIdentity&&(czSchema={...czSchema,properties:{...czSchema.properties,identity:{type:["string","null"]}},required:[...czSchema.required,"identity"]});let y=await «structured»({appServerClient:i,model:f,readOnlyAppToolAllowlist:u,cwd:n,fallbackToFreshThread:!c&&l,feature:"thread_title",experimentalPredictionMode:c,outputSchema:czSchema,prompt:czIdentity?m+"\\n"+czIdentity.prompt:m,responseSchema:czIdentity?{safeParse:value=>{let parsed=g.safeParse(value);if(parsed.success)parsed.data.identity=typeof value?.identity==="string"&&value.identity.length<=3500?value.identity:null;return parsed}}:g,`);
  s=replaceShape(s,'_=(0,«title»)(y?.title??"",t);return null==_?null:',`_=(0,«title»)(y?.title??"",t);if(czIdentity)${bridge}.accept(czIdentity,y?.identity);return null==_?null:`);
  return s;
}

const patches=[[SIDEBAR_IDENTITY_MAIN_TARGET,patchIdentityMain],[SIDEBAR_IDENTITY_PROJECTS_TARGET,patchIdentityProjects],[SIDEBAR_IDENTITY_THREADS_TARGET,patchIdentityThreads],[SIDEBAR_IDENTITY_PROJECT_EDITOR_TARGET,patchIdentityProjectEditor]];
export async function sidebarIdentityReplacements(archivePath,replacements=new Map()){
  const archive=await openAsar(archivePath);
  try{
    const located=await locateTargets(archive,patches.map(([target])=>target));
    for(const [target,patch] of patches){const name=located.get(target);replacements.set(name,Buffer.from(patch((replacements.get(name)??await archive.read(name)).toString())));}
    for(const [target,file] of [["webview/assets/codexzero-sidebar-identity.js","../assets/native-sidebar-identity.mjs"],["webview/assets/codexzero-sidebar-schema.js","./sidebar-identity-schema.mjs"],[".vite/build/codexzero-sidebar-appearance-main.cjs","../assets/native-sidebar-appearance-main.cjs"]])replacements.set(target,await fs.readFile(new URL(file,import.meta.url)));
    const preloadPath=".vite/build/preload.js",preload=(replacements.get(preloadPath)??await archive.read(preloadPath)).toString();
    if(!preload.includes('exposeInMainWorld("codexZeroAppearance"'))replacements.set(preloadPath,Buffer.from(preload+`\n;(()=>{const{contextBridge,ipcRenderer}=require("electron");if(location.protocol!=="app:"||location.hostname!=="-")return;contextBridge.exposeInMainWorld("codexZeroAppearance",{snapshot:()=>ipcRenderer.invoke("codexzero:appearance:snapshot"),observe:items=>ipcRenderer.invoke("codexzero:appearance:observe",items),update:value=>ipcRenderer.invoke("codexzero:appearance:update",value),subscribe:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on("codexzero:appearance:changed",listener);return()=>ipcRenderer.removeListener("codexzero:appearance:changed",listener)}});})();\n`));
    const earlyPath=".vite/build/early-bootstrap.js";replacements.set(earlyPath,Buffer.concat([Buffer.from(`require("./codexzero-sidebar-appearance-main.cjs");\n`),replacements.get(earlyPath)??await archive.read(earlyPath)]));
    return replacements;
  }finally{await archive.close();}
}
