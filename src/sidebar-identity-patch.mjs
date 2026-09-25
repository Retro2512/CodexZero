import fs from "node:fs/promises";
import { openAsar } from "./asar-patch.mjs";

function once(source,before,after){if(source.split(before).length!==2)throw new Error(`Unsupported appearance patch anchor: ${before.slice(0,80)}`);return source.replace(before,after);}
function inFunction(source,name,edit){const start=source.indexOf(`function ${name}(`),end=source.indexOf("function ",start+10);if(start<0||end<0)throw Error(`Missing appearance component ${name}`);return source.slice(0,start)+edit(source.slice(start,end))+source.slice(end);}
export function patchIdentityRenderer(source){
  let s=source;
  // Native elements retain their refs, drag listeners, semantics and memoized children.
  s=inFunction(s,"RMc",part=>once(part,",Vt}",",czProjectElement(O5,n,Vt)}"));
  s=inFunction(s,"S_c",part=>once(part,"children:a}),t[21]=a","children:czProjectIcon(b_c,l,a)}),t[21]=a"));
  s=once(s,"function QSc(e){","function QSc(e){return czThreadElement(tCc,czNativeQSc,e)}function czNativeQSc(e){");
  s=once(s,"metadataThreadId:n,initialValue:re??``,initialColor:null","metadataThreadId:n,metadataHostId:P,initialValue:re??``,initialColor:null");
  // Preserve native title/name/source actions and wrap Save with dirty appearance persistence.
  s=once(s,"function FCs(e){","function FCs(e){return czEditorSession(LCs,{...e,czKind:'project',czId:e.projectId},czNativeFCs)}function czNativeFCs(e){");
  s=inFunction(s,"czNativeFCs",part=>once(part,"children:[A,M,N,B]","children:[A,M,czEditorElement(LCs,{kind:'project',id:u,title:h}),N,B]"));
  s=once(s,"function I_c(e){","function I_c(e){return czEditorSession(k8,{...e,czKind:'thread',czId:e.metadataThreadId,czHostId:e.metadataHostId},czNativeI_c)}function czNativeI_c(e){");
  s=inFunction(s,"czNativeI_c",part=>once(part,"children:[ie,ae,oe]","children:[ie,czEditorElement(k8,{kind:'thread',id:n,hostId:e.metadataHostId,title:h}),ae,oe]"));
  // Existing project marker picker and emoji picker otherwise compete with this store.
  s=inFunction(s,"XSs",part=>once(part,"u=o!=null||i!=null","u=o==null&&i!=null"));
  s=inFunction(s,"czNativeI_c",part=>once(part,"E=v&&n!=null&&yU?.threadMetadata!=null","E=!1"));
  s=inFunction(s,"czNativeI_c",part=>once(part,"title:te,subtitle:ne","title:te"));
  s=once(s,'id:`sidebarElectron.renameThread`,defaultMessage:`Rename chat`','id:`codexzero.editTask`,defaultMessage:`Edit task`');
  s=once(s,'id:`sidebarElectron.renameThreadDialogTitle`,defaultMessage:`Rename chat`','id:`codexzero.editTaskTitle`,defaultMessage:`Edit task`');
  return 'import{projectElement as czProjectElement,projectIcon as czProjectIcon,threadElement as czThreadElement,editorSession as czEditorSession,editorElement as czEditorElement}from"./codexzero-sidebar-identity.js";\n'+s;
}
const bridge='require("./codexzero-sidebar-appearance-main.cjs")';
// Native structured generation reuses the selected provider/auth path. No shell, plugins or tools.
const generator='czOptions=>z8({...czOptions,cwd:null,serviceTier:null,effort:"low",threadSource:"appearance",client:this,timeoutMs:45000,baseInstructions:"Return the requested JSON only. Do not call tools or inspect files.",config:{...AN,"features.hooks":!1},responseSchema:{safeParse:value=>({success:!0,data:value})},allowProviderModelFallback:!1})';
export function patchIdentityMain(source){
  let s=once(source,'async listThreads(e,t,n){let r=',`async listThreads(e,t,n){${bridge}.register(this,${generator});let r=`);
  s=once(s,'async startTurn(e,t,n){return await this.ensureReady(),n?.(),this.automationTurns',`async startTurn(e,t,n){${bridge}.register(this,${generator},e);return await this.ensureReady(),n?.(),this.automationTurns`);
  s=once(s,'return e.ephemeral===!0&&this.markEphemeralThread(a.thread.id),a}',`return e.ephemeral===!0&&this.markEphemeralThread(a.thread.id),${bridge}.created(this,a,e),a}`);
  s=once(s,'this.broadcastThreadTitleUpdated(e,i,n))}',`this.broadcastThreadTitleUpdated(e,i,n),${bridge}.titleUpdated(this,e,i))}`);
  s=once(s,'let d=await X9({appServerClient:r,readOnlyAppToolAllowlist:s,cwd:t,fallbackToFreshThread:o,feature:`thread_title`,outputSchema:Xse,prompt:u,responseSchema:G9,',
    `let czIdentity=await ${bridge}.prepare(r,a,t),czSchema=czIdentity?{...Xse,properties:{...Xse.properties,identity:{type:["string","null"]}},required:[...Xse.required,"identity"]}:Xse;let d=await X9({appServerClient:r,readOnlyAppToolAllowlist:s,cwd:t,fallbackToFreshThread:o,feature:\`thread_title\`,outputSchema:czSchema,prompt:czIdentity?u+"\\n"+czIdentity.prompt:u,responseSchema:czIdentity?{safeParse:value=>{let parsed=G9.safeParse(value);if(parsed.success)parsed.data.identity=typeof value?.identity==="string"&&value.identity.length<=3500?value.identity:null;return parsed}}:G9,`);
  s=once(s,'f=Bne(d?.title??``);return f==null?null:{title:f,description:Y9(d?.description)}}',`f=Bne(d?.title??\`\`);if(czIdentity)${bridge}.accept(czIdentity,d?.identity);return f==null?null:{title:f,description:Y9(d?.description)}}`);
  return s;
}
export async function sidebarIdentityReplacements(archivePath,replacements=new Map()){
  const archive=await openAsar(archivePath);
  try{
    const assets=Object.keys(archive.header.files.webview.files.assets.files),initial=assets.filter(n=>/^app-initial-[\w-]+\.js$/.test(n));
    if(initial.length!==1)throw Error("Unsupported sidebar bundle");
    const rendererPath=`webview/assets/${initial[0]}`;
    replacements.set(rendererPath,Buffer.from(patchIdentityRenderer((replacements.get(rendererPath)??await archive.read(rendererPath)).toString())));
    const mainNames=Object.keys(archive.header.files[".vite"].files.build.files).filter(n=>/^src-[\w-]+\.js$/.test(n));let found=0;
    for(const name of mainNames){const full=`.vite/build/${name}`,source=(replacements.get(full)??await archive.read(full)).toString();if(!source.includes('async function ece({prompt:e'))continue;replacements.set(full,Buffer.from(patchIdentityMain(source)));found++;}
    if(found!==1)throw Error("Unsupported title generation bundle");
    for(const [target,file] of [["webview/assets/codexzero-sidebar-identity.js","../assets/native-sidebar-identity.mjs"],["webview/assets/codexzero-sidebar-schema.js","./sidebar-identity-schema.mjs"],[".vite/build/codexzero-sidebar-appearance-main.cjs","../assets/native-sidebar-appearance-main.cjs"]])replacements.set(target,await fs.readFile(new URL(file,import.meta.url)));
    const preloadPath=".vite/build/preload.js",preload=(replacements.get(preloadPath)??await archive.read(preloadPath)).toString();
    if(!preload.includes('exposeInMainWorld("codexZeroAppearance"'))replacements.set(preloadPath,Buffer.from(preload+`\n;(()=>{const{contextBridge,ipcRenderer}=require("electron");if(location.protocol!=="app:"||location.hostname!=="-")return;contextBridge.exposeInMainWorld("codexZeroAppearance",{snapshot:()=>ipcRenderer.invoke("codexzero:appearance:snapshot"),observe:items=>ipcRenderer.invoke("codexzero:appearance:observe",items),update:value=>ipcRenderer.invoke("codexzero:appearance:update",value),subscribe:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on("codexzero:appearance:changed",listener);return()=>ipcRenderer.removeListener("codexzero:appearance:changed",listener)}});})();\n`));
    const earlyPath=".vite/build/early-bootstrap.js";replacements.set(earlyPath,Buffer.concat([Buffer.from(`require("./codexzero-sidebar-appearance-main.cjs");\n`),replacements.get(earlyPath)??await archive.read(earlyPath)]));
    return replacements;
  }finally{await archive.close();}
}
