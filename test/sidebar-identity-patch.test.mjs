import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as identity from "../src/sidebar-identity-patch.mjs";
import { patchThreadVisibilityMain, THREAD_VISIBILITY_MAIN_TARGET } from "../src/thread-visibility-patch.mjs";
import { bundledAvailable, bundledPath, bundledSources, blockEnd, evaluate } from "./bundled-source.mjs";

const { patchIdentityMain, patchIdentityProjects, patchIdentityThreads, patchIdentityProjectEditor } = identity;
const bundled = { skip: !bundledAvailable && "Unpacked desktop bundle unavailable" };
const patches = [
  ["main", patchIdentityMain, identity.SIDEBAR_IDENTITY_MAIN_TARGET, ".cjs"],
  ["projects", patchIdentityProjects, identity.SIDEBAR_IDENTITY_PROJECTS_TARGET, ".mjs"],
  ["threads", patchIdentityThreads, identity.SIDEBAR_IDENTITY_THREADS_TARGET, ".mjs"],
  ["projectEditor", patchIdentityProjectEditor, identity.SIDEBAR_IDENTITY_PROJECT_EDITOR_TARGET, ".mjs"],
];

test("identity transformations reject unsupported bundles without partial results",()=>{
  for(const patch of [patchIdentityProjects,patchIdentityThreads,patchIdentityProjectEditor])assert.throws(()=>patch("export{}"),/Missing appearance component/);
  assert.throws(()=>patchIdentityMain("export{}"),/Unsupported bundle anchor/);
});

// The macOS build of the same release bundles the main process with different minified names.
const macBuild=process.env.CODEXZERO_TEST_MAC_APP?path.join(process.env.CODEXZERO_TEST_MAC_APP,".vite/build"):"work/upstream-mac-26.1103/app/.vite/build";
test("main process patches apply to both the Windows and macOS bundle shapes",{skip:!bundledAvailable||!existsSync(macBuild)?"Unpacked desktop bundles unavailable":false},async()=>{
  const windows=bundledSources({identity:identity.SIDEBAR_IDENTITY_MAIN_TARGET,visibility:THREAD_VISIBILITY_MAIN_TARGET});
  const mac={};
  for(const name of await fs.readdir(macBuild)){
    const source=await fs.readFile(path.join(macBuild,name),"utf8");
    for(const [key,target] of [["identity",identity.SIDEBAR_IDENTITY_MAIN_TARGET],["visibility",THREAD_VISIBILITY_MAIN_TARGET]])if(source.includes(target)){assert.equal(mac[key],undefined,`${key} target must be unique`);mac[key]=source;}
  }
  assert.notEqual(mac.visibility,windows.visibility);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"codexzero-main-"));
  try{
    for(const [platform,sources] of [["windows",windows],["mac",mac]])for(const [key,patch] of [["identity",patchIdentityMain],["visibility",patchThreadVisibilityMain]]){
      const file=path.join(dir,`${platform}-${key}.cjs`);
      await fs.writeFile(file,patch(sources[key]));
      execFileSync(process.execPath,["--check",file],{stdio:"pipe"});
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("native build and app server include appearance integration",async()=>{
  const build=await fs.readFile(new URL("../src/native-provider-build.mjs",import.meta.url),"utf8");
  assert.match(build,/await sidebarIdentityReplacements\(archivePath, replacements\)/);
  const bridge=await fs.readFile(new URL("../src/provider-app-server.mjs",import.meta.url),"utf8");
  assert.match(bridge,/mcp_servers\.codexzero_appearance/);
  assert.match(bridge,/if \(params\.ephemeral\)/);
});

test("each bundled identity target resolves to one file whose patched code still parses",bundled,async()=>{
  const sources=bundledSources(Object.fromEntries(patches.map(([name,,target])=>[name,target])));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"codexzero-identity-"));
  try{
    for(const [name,patch,,extension] of patches){
      const patched=patch(sources[name]),file=path.join(dir,name+extension);
      assert.throws(()=>patch(patched),`${name} must not apply twice`);
      await fs.writeFile(file,patched);
      execFileSync(process.execPath,["--check",file],{stdio:"pipe"});
      if(extension===".mjs")assert.ok(patched.startsWith('import{')&&patched.includes('from"../codexzero-sidebar-identity.js"'));
    }
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

function writeArchive(file,entries){
  const header={files:{}},data=[];let offset=0;
  for(const [name,bytes] of entries){
    const keys=name.split("/");let node=header;
    for(const key of keys.slice(0,-1))node=(node.files[key]??={files:{}});
    node.files[keys.at(-1)]={size:bytes.length,offset:String(offset)};data.push(bytes);offset+=bytes.length;
  }
  const json=Buffer.from(JSON.stringify(header)),headerSize=8+json.length+(4-json.length%4)%4,pickle=Buffer.alloc(8+headerSize);
  pickle.writeUInt32LE(4,0);pickle.writeUInt32LE(headerSize,4);pickle.writeUInt32LE(headerSize-4,8);pickle.writeUInt32LE(json.length,12);json.copy(pickle,16);
  return fs.writeFile(file,Buffer.concat([pickle,...data]));
}

test("archive replacements locate every identity file by content instead of by name",bundled,async()=>{
  const sources=bundledSources(Object.fromEntries(patches.map(([name,,target])=>[name,target])));
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"codexzero-identity-")),archive=path.join(dir,"app.asar");
  try{
    const entries=patches.map(([name,,target])=>[bundledPath(target),Buffer.from(sources[name])]);
    entries.push([".vite/build/preload.js",Buffer.from("// preload\n")],[".vite/build/early-bootstrap.js",Buffer.from("// early\n")],["webview/assets/async/unrelated.js",Buffer.from("export{}")]);
    await writeArchive(archive,entries);
    const replacements=await identity.sidebarIdentityReplacements(archive);
    for(const [name,patch,target] of patches)assert.equal(replacements.get(bundledPath(target)).toString(),patch(sources[name]));
    assert.equal(replacements.has("webview/assets/async/unrelated.js"),false);
    assert.match(replacements.get(".vite/build/preload.js").toString(),/codexZeroAppearance/);
    assert.match(replacements.get(".vite/build/early-bootstrap.js").toString(),/^require\("\.\/codexzero-sidebar-appearance-main\.cjs"\);\n\/\/ early/);
    for(const name of ["webview/assets/codexzero-sidebar-identity.js","webview/assets/codexzero-sidebar-schema.js",".vite/build/codexzero-sidebar-appearance-main.cjs"])assert.ok(replacements.has(name));
    entries.push(["webview/assets/async/copy.js",Buffer.from(sources.threads)]);
    await writeArchive(archive,entries);
    await assert.rejects(identity.sidebarIdentityReplacements(archive),/needs an updated patch target/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test("bundled title hook preserves title parsing and only adds a bounded identity field",bundled,async()=>{
  const patched=patchIdentityMain(bundledSources({main:identity.SIDEBAR_IDENTITY_MAIN_TARGET}).main);
  const start=patched.indexOf("async function du({prompt:e,"),code=patched.slice(start,blockEnd(patched,patched.indexOf("){",start)+1));
  const accepted=[],requests=[];let context={prompt:"Identity prompt",items:[]};let identityValue='{"items":[]}';
  const bridge={prepare:async()=>context,accept:(...args)=>accepted.push(args)};
  const chain=new Proxy({},{get:()=>()=>chain});
  const generate=async args=>{requests.push(args);return args.responseSchema.safeParse({title:"Fix scrolling",description:"Sidebar scroll fix",identity:identityValue}).data;};
  const du=evaluate(code,{require:()=>bridge,B:{ToG:60,AAe:value=>value||null},ou:"model",oo:async()=>"model",dt:chain,dp:value=>value,dm:generate,
    d:{string:()=>chain,object:()=>({safeParse:value=>({success:true,data:{title:value.title,description:value.description}})})},
    ew:()=>({properties:{title:{type:"string"},description:{type:"string"}},required:["title","description"]})},"du");
  assert.deepEqual(await du({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t"}),{title:"Fix scrolling",description:"Sidebar scroll fix"});
  assert.ok(requests[0].outputSchema.required.includes("identity"));assert.match(requests[0].prompt,/Identity prompt/);
  identityValue="x".repeat(3501);await du({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t"});assert.equal(accepted[1][1],null);
  context=null;await du({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t"});assert.deepEqual(requests[2].outputSchema.required,["title","description"]);assert.equal(accepted.length,2);
  await du({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t",experimentalPredictionMode:!0});assert.equal(requests[3].outputSchema,null);assert.equal(accepted.length,2);
});
