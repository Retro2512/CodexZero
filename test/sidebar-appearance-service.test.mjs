import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppearanceService, identityKey } from "../src/sidebar-appearance-service.mjs";
import { requestAppearance } from "../src/sidebar-appearance-client.mjs";

async function setup(t, { generate, brandHints } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "appearance-service-"));
  const state = { account: "account-a", calls: [], principalListeners: [] };
  const client = {
    options: { hostId: "local" },
    getCachedAuthenticatedPrincipal: () => ({ accountId: state.account, userId: "user-a" }),
    registerInternalAuthenticatedPrincipalChangeHandler(listener) {
      state.principalListeners.push(listener);
      return () => { state.principalListeners = state.principalListeners.filter(item => item !== listener); };
    },
    async sendAppServerRequest(method, args) {
      state.calls.push([method, args]);
      if (method === "project/list") return { data: [], nextCursor: null };
      if (method === "config/read") return { config: { model: "configured-model" } };
      throw new Error("Unexpected request");
    },
    async listThreads() { return { data: [], nextCursor: null }; },
    async readThread(id) { return { id, title: `Thread ${id}`, cwd: "C:/work/project" }; },
  };
  const service = new AppearanceService({ home, brandHints: brandHints ?? (async () => ({ colors: ["#123456"], sources: ["icon"] })) });
  service.registerClient(client, generate ?? (async () => ({ items: [] })), { model: "selected-model" });
  t.after(async () => { await service.close(); await fs.rm(home, { recursive: true, force: true }); });
  return { service, client, state, home };
}

const project = { kind: "project", id: "project-1", hostId: "local", title: "Existing App", cwd: "C:/work/project" };
const thread = { kind: "thread", id: "thread-1", hostId: "local", title: "Fix login", cwd: "C:/work/project", projectId: "project-1" };

test("automatic preset tasks add no model request and changes publish their exact identity",async t=>{
  let calls=0;const {service,client}=await setup(t,{generate:async()=>{calls++;return {items:[]};}});
  const events=[];service.notify=event=>events.push(event);
  await service.observe([project,thread]);await service.update({...project,patch:{palette:"teal",iconMode:"preset"}});
  service.titleUpdated(client,thread.id,"Fix login");await service.flushAutomatic();
  const record=(await service.snapshot()).records[identityKey(thread)];
  assert.equal(calls,0);assert.equal(record.category,"fix");assert.equal(record.iconMode,"preset");
  assert.equal(events.at(-1).key,identityKey(thread));assert.equal(events.at(-1).record.category,"fix");
});

test("observe creates catalog only; update requires an existing target and valid patch", async t => {
  const { service } = await setup(t);
  assert.deepEqual(await service.observe([project, thread]), { ok: true });
  assert.equal((await service.snapshot()).revision, 0);
  await assert.rejects(service.update({ kind: "thread", id: "missing", patch: { palette: "blue" } }), /not found/);
  await assert.rejects(service.update({ ...thread, patch: { injected: true } }), /unsupported/);
  await assert.rejects(service.update({ ...thread, patch: { name: "Hidden" } }), /name field/);
  const record = await service.update({ ...thread, patch: { palette: "blue", tone: 1 } });
  assert.equal(record.palette, "blue");
  assert.equal(record.origins.palette, "manual");
  const key = identityKey(thread);
  assert.deepEqual(Object.keys((await service.snapshot()).records), [key]);
  assert.equal((await service.update({ ...thread, expectedRevision: 0, patch: { tone: 2 } })).tone, 1);
});

test("account scopes separate records and observed catalog", async t => {
  const { service, state } = await setup(t);
  await service.observe([project]);
  await service.update({ ...project, patch: { color: "#123456" } });
  const first = await service.snapshot();
  state.account = "account-b";
  state.principalListeners.forEach(listener => listener());
  assert.equal((await service.snapshot()).revision, 0);
  assert.equal((await service.list({ kind: "project" })).items.length, 0);
  state.account = "account-a";
  assert.deepEqual(await service.snapshot(), first);
});

test("title context piggybacks project brand and invalid identity cannot affect title or write extra keys", async t => {
  const { service, client } = await setup(t);
  await service.observe([project, thread]);
  const context = await service.titleContext(client, thread.id, thread.cwd);
  assert.deepEqual(context.items.map(item => item.kind), ["project", "thread"]);
  assert.deepEqual(context.items[0].brand.colors, ["#123456"]);
  assert.match(context.prompt, /title and description/);
  const revisionBeforeInvalid=(await service.snapshot()).revision;
  const wrong = await service.accept(context, { items: [{ key: context.items[1].key, patch: { palette: "blue", injected: true } }] });
  assert.equal(wrong.updated, 0);
  assert.equal((await service.snapshot()).revision, revisionBeforeInvalid);
  assert.equal((await service.list({ kind: "thread" })).items[0].title, thread.title);
  const unknown = await service.accept(context, { items: [{ key: "other", patch: { palette: "blue" } }] });
  assert.equal(unknown.updated, 0);
  assert.equal((await service.snapshot()).revision, revisionBeforeInvalid);
});

test("automatic identity respects manual fields and derives related thread color from parent", async t => {
  const { service, client } = await setup(t);
  await service.observe([project, thread]);
  await service.update({ ...project, patch: { palette: "rose", tone: 2 } });
  await service.update({ ...thread, patch: { category: "fix" } });
  const context = {
    scopeId: service.scope().id,
    items: await service.contextFor([thread]),
  };
  const result = await service.accept(context, { items: [{ key: identityKey(thread), patch: {
    palette: "green", color: "#00FF00", tone: 1, category: "design", iconMode: "custom",
    drawing: { shapes: [{ type: "circle", cx: 12, cy: 12, r: 5 }] },
  } }] }, { replace: true });
  assert.equal(result.updated, 1);
  const record = (await service.snapshot()).records[identityKey(thread)];
  assert.equal(record.category, "fix");
  assert.equal(record.origins.category, "manual");
  assert.equal(record.tone, 1);
  assert.equal(record.palette, undefined);
  assert.equal(record.color, undefined);
  assert.equal(record.iconMode, "preset");
  assert.equal(record.drawing, null);
  const listed = (await service.list({ kind: "thread" })).items[0];
  assert.equal(listed.parentAppearance.palette, "rose");
  assert.equal(listed.appearance.category, "fix");
  assert.equal(await service.titleContext(client, thread.id, thread.cwd), null);
});

test("background backfill batches, skips existing identities, uses selected model, and reports partial failure", async t => {
  const generated = [];
  const { service } = await setup(t, { generate: async ({ prompt, model }) => {
    generated.push({ prompt, model });
    if (generated.length === 2) throw new Error("Model failed");
    const items = JSON.parse(prompt.split("\n")[1]);
    return { items: items.map(item => ({ key: item.key, patch: JSON.stringify({ category: "feature", tone: 1, iconMode: "preset" }) })) };
  } });
  const threads = Array.from({ length: 13 }, (_, i) => ({ kind: "thread", id: `bulk-${i}`, hostId: "local", title: `Build ${i}` }));
  await service.observe(threads);
  await service.update({ ...threads[0], patch: { palette: "blue" } });
  const initial = await service.backfill({ scope: "threads", limit: 12 });
  assert.equal(initial.status, "running");
  assert.equal(initial.total, 12);
  let status;
  for (let i = 0; i < 100; i++) {
    status = await service.operation("status", { id: initial.id });
    if (status.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status.status, "partial");
  assert.equal(status.processed, 12);
  assert.equal(status.updated, 6);
  assert.equal(status.failed, 6);
  assert.equal(generated.length, 2);
  assert.deepEqual(generated.map(call => call.model), ["selected-model", "selected-model"]);
  assert.equal((await service.snapshot()).records[identityKey(threads[0])].palette, "blue");
});

test("HTTP endpoint rejects unauthorized and browser requests; authorized list and update work", async t => {
  const { service, home } = await setup(t);
  await service.observe([project]);
  const port = await service.listen();
  const descriptor = JSON.parse(await fs.readFile(path.join(home, "appearance-endpoint.json"), "utf8"));
  assert.equal(descriptor.port, port);
  assert.match(descriptor.token, /^[a-f0-9]{64}$/);
  const url = `http://127.0.0.1:${port}/appearance`;
  const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"operation":"list","args":{}}' });
  assert.equal(unauthorized.status, 403);
  const browser = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, origin: "https://example.com" }, body: '{"operation":"list","args":{}}' });
  assert.equal(browser.status, 403);
  const preflight = await fetch(url, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST" } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.equal((await requestAppearance("list", { kind: "project" }, { home })).items.length, 1);
  const result = await requestAppearance("update", { ...project, patch: { palette: "teal" } }, { home });
  assert.equal(result.palette, "teal");
  assert.equal((await requestAppearance("list", { kind: "project" }, { home })).items[0].appearance.palette, "teal");
});

const fixtureImage="data:image/svg+xml;base64,"+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#225588" d="M2 2h20v20H2z"/></svg>').toString('base64');
async function done(service,job){for(let i=0;i<200;i++){const status=await service.operation("status",{id:job.id});if(status.status!=="running")return status;await new Promise(resolve=>setTimeout(resolve,10));}throw Error("Job did not finish");}
test("one project reuses its actual image locally without enumerating tasks or touching peers",async t=>{
 let calls=0;const {service,client,state}=await setup(t,{brandHints:async()=>({image:fixtureImage,colors:["#225588"],sources:["logo.svg"]}),generate:async()=>{calls++;throw Error("Unexpected model");}});
 client.listThreads=async()=>{throw Error("Must not enumerate tasks for one project");};
 await service.observe([project,{...project,id:"other",title:"Other",cwd:"C:/work/other"},thread]);
 const job=await done(service,await service.backfill({scope:"projects",project:"existing app"}));
 assert.equal(job.total,1);assert.equal(job.reused,1);assert.equal(job.updated,1);assert.equal(job.modelRequests,0);assert.equal(calls,0);assert.equal(state.calls.length,0);
 const records=(await service.snapshot()).records;assert.deepEqual(Object.keys(records),[identityKey(project)]);assert.equal(records[identityKey(project)].image,fixtureImage);assert.equal(records[identityKey(project)].color,"#225588");
});
test("local only does not call the model and project paths and IDs resolve exactly",async t=>{
 let calls=0;const {service}=await setup(t,{brandHints:async()=>({colors:[],sources:[]}),generate:async()=>{calls++;return {items:[]};}});await service.observe([project]);
 for(const selector of [project.id,project.cwd]){const result=await done(service,await service.backfill({scope:"projects",project:selector,localOnly:true}));assert.equal(result.modelRequests,0);assert.equal(result.skipped,1);}
 assert.equal(calls,0);assert.equal((await service.snapshot()).revision,0);
});
test("ambiguous project names fail before writes or model requests",async t=>{
 const {service}=await setup(t);await service.observe([project,{...project,id:"other",cwd:"C:/elsewhere"}]);
 await assert.rejects(service.backfill({scope:"projects",project:project.title}),/ambiguous/);assert.equal((await service.snapshot()).revision,0);
});
test("replacement adopts real branding but preserves manual color and icon choices",async t=>{
 let calls=0;const {service}=await setup(t,{brandHints:async()=>({image:fixtureImage,colors:["#225588"],sources:["logo.svg"]}),generate:async()=>{calls++;return {items:[]};}});await service.observe([project]);
 await service.update({...project,patch:{color:"#CC3344",iconMode:"preset",category:"design"}});
 const status=await done(service,await service.backfill({scope:"projects",project:project.id,replace:true,localOnly:true}));
 const record=(await service.snapshot()).records[identityKey(project)];assert.equal(record.color,"#CC3344");assert.equal(record.iconMode,"preset");assert.equal(record.category,"design");assert.equal(record.image,undefined);assert.equal(calls,0);assert.equal(status.failed,0);
});
test("background project discovery copies branding without model requests",async t=>{
 let calls=0;const {service}=await setup(t,{brandHints:async()=>({image:fixtureImage,colors:["#225588"],sources:["logo.svg"]}),generate:async()=>{calls++;return {items:[]};}});
 await service.observe([project]);await service.flushBrands();const record=(await service.snapshot()).records[identityKey(project)];assert.equal(record.image,fixtureImage);assert.equal(record.iconMode,"asset");assert.equal(calls,0);
});
test("project task generation is local and model context never includes parent image payloads",async t=>{
 let calls=0;const {service}=await setup(t,{brandHints:async()=>({image:fixtureImage,colors:["#225588"],sources:["logo.svg"]}),generate:async()=>{calls++;return {items:[]};}});await service.observe([project,thread]);await service.flushBrands();
 const status=await done(service,await service.backfill({scope:"threads",project:project.id}));assert.equal(status.modelRequests,0);assert.equal(calls,0);assert.equal((await service.snapshot()).records[identityKey(thread)].category,"fix");
 const context=await service.contextFor([project,thread]);assert.equal(JSON.stringify(context).includes('base64'),false);assert.equal(context[0].brand.hasImage,true);
});
