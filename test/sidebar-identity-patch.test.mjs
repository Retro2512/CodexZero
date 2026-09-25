import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {patchIdentityRenderer,patchIdentityMain} from "../src/sidebar-identity-patch.mjs";
import { openAsar } from "../src/asar-patch.mjs";

test("identity transformations reject unsupported bundles without partial results",()=>{
  assert.throws(()=>patchIdentityRenderer("export{}"),/Missing appearance component/);
  assert.throws(()=>patchIdentityMain("export{}"),/Unsupported appearance patch anchor/);
});
test("native build and app server include appearance integration",async()=>{
  const build=await fs.readFile(new URL("../src/native-provider-build.mjs",import.meta.url),"utf8");
  assert.match(build,/await sidebarIdentityReplacements\(archivePath, replacements\)/);
  assert.match(build,/patchTranscriptRetention\(patchSidebarRenderer\(initial\)\)/);
  assert.match(build,/patchSelectionScroll\(replacements\.get\(primaryPath\)/);
  const bridge=await fs.readFile(new URL("../src/provider-app-server.mjs",import.meta.url),"utf8");
  assert.match(bridge,/mcp_servers\.codexzero_appearance/);
  assert.match(bridge,/if \(params\.ephemeral\)/);
});

test("packaged title hook preserves title parsing and only adds a bounded identity field",async t=>{
  const file=new URL("../work/responsiveness-preview-20260923/desktop/resources/app.asar",import.meta.url);
  try{await fs.access(file);}catch{t.skip("Local desktop fixture unavailable");return;}
  const archive=await openAsar(file);let source;
  try{for(const name of Object.keys(archive.header.files[".vite"].files.build.files)){if(!/^src-.*\.js$/.test(name))continue;const value=(await archive.read(`.vite/build/${name}`)).toString();if(value.includes("async function ece({prompt:e")){source=value;break;}}}finally{await archive.close();}
  const patched=patchIdentityMain(source);const start=patched.indexOf("async function ece("),end=patched.indexOf("async function tce(",start);const code=patched.slice(start,end);
  const accepted=[],requests=[];let context={prompt:"Identity prompt",items:[]};let identity='{"items":[]}';
  const bridge={prepare:async()=>context,accept:(...args)=>accepted.push(args)};
  const schema={properties:{title:{type:"string"},description:{type:"string"}},required:["title","description"]};
  const responseSchema={safeParse:value=>({success:true,data:{title:value.title,description:value.description}})};
  const generate=async args=>{requests.push(args);return args.responseSchema.safeParse({title:"Fix scrolling",description:"Sidebar scroll fix",identity}).data;};
  const fn=new Function("require","X9","G9","Xse","Bne","Y9","V9",code+";return ece;")(()=>bridge,generate,responseSchema,schema,x=>x,x=>x,30000);
  assert.deepEqual(await fn({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t"}),{title:"Fix scrolling",description:"Sidebar scroll fix"});
  assert.ok(requests[0].outputSchema.required.includes("identity"));assert.match(requests[0].prompt,/Identity prompt/);
  identity="x".repeat(3501);await fn({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t"});assert.equal(accepted[1][1],null);
  context=null;await fn({prompt:"Title prompt",appServerClient:{},sourceThreadId:"t"});assert.equal(requests[2].outputSchema,schema);assert.equal(accepted.length,2);
});
