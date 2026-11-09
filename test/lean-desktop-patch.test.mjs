import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DOTS_DESKTOP_FEATURES, LEAN_FILE_PATCHES, STRIPPED_CAPABILITY, STRIPPED_BUNDLED_PLUGINS, STRIPPED_DESKTOP_FEATURES,
  WORK_MODE_DESKTOP_FEATURES, chunkModules, disableAnalytics, leanChunkReplacements, patchLeanCheckout, patchLeanDesktopFeatures, patchLeanMain,
  patchLeanPrefetch, patchLeanRenderer, patchLeanSidebar, pruneCopiedDesktop, stubComponentChunk
} from "../src/lean-desktop-patch.mjs";

test("ChatGPT, Dots and toy capabilities are stripped while coding capabilities remain", () => {
  for (const name of ["chatgpt", "chatgpt.quick-chat", "chatgpt.seat-access", "orbit", "orbit.navigation", "toys.confetti", "demo-tools"]) {
    assert.ok(STRIPPED_CAPABILITY.test(name), name);
  }
  for (const name of ["dictation", "dictation.global", "browser.in-app", "automations.local", "codex.browser", "chatgptish", "orbital"]) {
    assert.ok(!STRIPPED_CAPABILITY.test(name), name);
  }
});

test("every file patch names a short, distinct target", () => {
  assert.equal(new Set(LEAN_FILE_PATCHES.map(([target]) => target)).size, LEAN_FILE_PATCHES.length);
  for (const [target, patch] of LEAN_FILE_PATCHES) {
    assert.equal(typeof target, "string");
    assert.ok(target.length > 0 && target.length < 40, target);
    assert.equal(typeof patch, "function");
  }
});

const rendererFixture = [
  'h=(0,r.i1)(l.u,(e,{get:t})=>{var n;let r=p[e.name];if(null==r||!(null==(n=r).supportedClients||n.supportedClients.includes("electron")))return{isLoading:!1,isError:!1,isCapable:!1};return{isCapable:!0}})',
  'p=(0,r.un)(o.u,({get:e})=>{let t=e(a.lN);if("denied"===t.status&&"unsupported-auth"===t.reason)return"coding";return"everyday"})',
  'p=(0,r.un)(l.u,({get:e})=>{let t=(0,u.g4)(e,i.ubS.conversationDetailMode),n=e(o.$T)?.roles;return"work"})',
  "d={Wy:async function(){await Promise.all([s.prefetch(),o.prefetch(),l.prefetch(),i.v.prefetch()])}}",
  'd=(0,i.RD)(a.u,({get:e})=>({enabled:e(o.JW,"637432221"),queryKey:["appgen","access"]}))',
  'c=(0,i.un)(a.u,({get:e})=>{if(!e(o.JW,"637432221"))return"unavailable";return"available"})',
  'p=(0,r.un)(o.u,({get:e})=>{let t=e(a.m0);if("loading"===t.status)return"loading";if("allowed"!==t.status)return"unavailable";let n=e(a.chatGptAuthenticatedAccountId$),r=e(l.M9);return"available"})',
  "c=e=>e.analytics?.enabled!==!1",
].join("\n");
const mainFixture = [
  "f({ambientSuggestions:s.ambientSuggestions,quickChat:!0,dotBrowserUse:s.dotBrowserUse,workCloudAccess:s.workCloudAccess,deepResearch:s.deepResearch,visualizeLive:s.visualizeLive,workspaceDir:s.workspaceDir},s.bundledPluginEligibilityReasons)",
  "{...es.iRL.latex,isAvailable:()=>!0}",
  "{...es.iRL.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!0}",
  "x=null==this.threadCatalogSyncManager?void 0:new etM(this.threadCatalogSyncManager,{})",
  "async getState(){let e=await this.getService();e.start();let t=e.getState();return this.syncSessionLockMonitor(t),t}",
  "c=e=>e.analytics?.enabled!==!1",
].join("\n");
const rendererFeatures = current => ({ codexZeroFeatures: { current } });
const run = (code, names, ...values) => new Function(...names, "globalThis", code)(...values);

test("ChatGPT capabilities follow Work mode or ChatGPT chats, and Dots capabilities follow Dots", () => {
  const [line] = patchLeanRenderer(rendererFixture).split("\n");
  const capable = (name, features, known = true) => run(`let h,p=known?{[name]:{}}:{},r={i1:(_,f)=>f},l={};${line};return h({name},{get:()=>{}})`,
    ["name", "known"], name, known, rendererFeatures(features)).isCapable;
  assert.equal(capable("dictation", null), true);
  assert.equal(capable("dictation", null, false), false);
  assert.equal(capable("chatgpt", null), false);
  assert.equal(capable("orbit.navigation", null), false);
  assert.equal(capable("chatgpt.seat-access", { workMode: false, chats: false }), false);
  assert.equal(capable("chatgpt", { workMode: true }), true);
  assert.equal(capable("chatgpt.seat-access", { chats: true }), true);
  assert.equal(capable("orbit", { chats: true }), false);
  assert.equal(capable("orbit", { dots: true }), true);
  assert.equal(capable("chatgpt", { dots: true }), false);
  assert.equal(capable("toys.confetti", { workMode: true, chats: true, dots: true }), false);
});

test("coding presentation, Codex product mode and Dots prefetching follow the saved choices", () => {
  const [, presentation, productMode, prefetch] = patchLeanRenderer(rendererFixture).split("\n");
  const atom = (line, features) => run(`let p,r={un:(_,f)=>f},o={u:0},l={u:0},a={},u={g4:()=>null},i={ubS:{}};${line};return p({get:()=>({})})`, [], rendererFeatures(features));
  assert.equal(atom(presentation, null), "coding");
  assert.equal(atom(presentation, { chats: true, dots: true }), "coding");
  assert.equal(atom(presentation, { workMode: true }), "everyday");
  assert.equal(atom(productMode, null), "codex");
  assert.equal(atom(productMode, { workMode: true }), "work");
  const prefetched = async features => {
    const calls = [];
    const page = name => ({ prefetch: () => calls.push(name) });
    await run(`let d;${prefetch};return d.Wy()`, ["s", "o", "l", "i"], page("route"), page("dots"), page("dot"), { v: page("other") }, rendererFeatures(features));
    return calls;
  };
  return Promise.all([prefetched(null), prefetched({ dots: true })]).then(([off, on]) => {
    assert.deepEqual(off, ["route", "other"]);
    assert.deepEqual(on, ["route", "dots", "dot", "other"]);
  });
});

test("Sites is always gone and the ChatGPT library follows the ChatGPT surfaces", () => {
  const [, , , , access, sites, library] = patchLeanRenderer(rendererFixture).split("\n");
  const get = () => ({ status: "allowed" });
  const value = (line, features) => run(`let d,c,p,i={RD:(_,f)=>f,un:(_,f)=>f},r=i,a={u:0},o={u:0,JW:0},l={};${line};return(d??c??p)({get})`,
    ["get"], get, rendererFeatures(features));
  assert.equal(value(access, { chats: true }).enabled, false);
  assert.equal(value(sites, { workMode: true, chats: true, dots: true }), "unavailable");
  assert.equal(value(library, null), "unavailable");
  assert.equal(value(library, { dots: true }), "unavailable");
  assert.equal(value(library, { chats: true }), "available");
  assert.equal(value(library, { workMode: true }), "available");
});

test("the sidebar mode switch stays on Codex unless a ChatGPT surface is on", () => {
  const anchor = '{"aria-describedby":P,codexAvailable:M,disabled:T,mode:E,navigationHeading:N,onModeSelect:L,onNewChat:R,workModeAccess:O}=e,';
  const header = patchLeanSidebar(anchor + "U=void 0!==N&&N;");
  const label = features => run(`let ${header}return{disabled:T,mode:E,onNewChat:R}`, ["e"],
    { disabled: false, mode: "work", onNewChat: "home" }, rendererFeatures(features));
  assert.deepEqual(label(null), { disabled: true, mode: "codex", onNewChat: undefined });
  assert.deepEqual(label({ dots: true }), { disabled: true, mode: "codex", onNewChat: undefined });
  assert.deepEqual(label({ chats: true }), { disabled: false, mode: "work", onNewChat: "home" });
});

test("background pages are only prewarmed for surfaces that are on", () => {
  const fixture = [
    "{onDemandEnabled:k,shouldPrewarmAvatarOverlay:t&&eT}",
    'y=(0,i.jsx)(fy,{phase:"background_ready",children:(0,i.jsx)(gL,{})})',
    'a=e.watch(({get:e})=>{"disabled"===e(t)?i.prewarm():i.dispose()})',
  ].join("\n");
  const [avatar, visualization, dil] = patchLeanDesktopFeatures(fixture).split("\n");
  assert.equal(avatar, "{onDemandEnabled:k,shouldPrewarmAvatarOverlay:!1}");
  assert.equal(visualization, "y=null");
  const warmed = features => {
    let result;
    run(dil, ["e", "t", "i"], { watch: f => f({ get: () => "disabled" }) }, 0,
      { prewarm: () => { result = "prewarm"; }, dispose: () => { result = "dispose"; } }, rendererFeatures(features));
    return result;
  };
  assert.equal(warmed(null), "dispose");
  assert.equal(warmed({ dots: true }), "dispose");
  assert.equal(warmed({ chats: true }), "prewarm");
  assert.throws(() => patchLeanDesktopFeatures("{}"), /anchor/);
});

test("embedded ChatGPT checkout pages are only prewarmed while a ChatGPT surface is on", () => {
  const fixture = [
    'x=!H&&((0,g.$t)()||"chatgpt"!==E||$||null==G||D||T?.structure!=="personal")',
    'm=!(0,g.$t)()&&"chatgpt"===V&&!Z&&null!=Q&&!et&&Y?.structure==="personal"&&!0?"search":null',
  ].join("\n");
  const [credit, pricing] = patchLeanCheckout(fixture).split("\n");
  const g = { $t: () => false };
  const hidden = (features, onRoute = false) => run(`let x;${credit};return x`, ["H", "g", "E", "$", "G", "D", "T"],
    onRoute, g, "chatgpt", false, "user", false, { structure: "personal" }, rendererFeatures(features));
  assert.equal(hidden(null), true);
  assert.equal(hidden(null, true), false);
  assert.equal(hidden({ chats: true }), false);
  const search = features => run(`let m;${pricing};return m`, ["g", "V", "Z", "Q", "et", "Y"],
    g, "chatgpt", false, "user", false, { structure: "personal" }, rendererFeatures(features));
  assert.equal(search(null), null);
  assert.equal(search({ workMode: true }), "search");
});

test("startup prefetching skips Dots and ChatGPT billing unless they are on", () => {
  const fixture = 'x.$O.prefetch(),t.e(846474).then(t.bind(t,"w7xK")).catch(()=>void 0),(0,S.Wy)();eq="chatgpt"===eT&&!eL&&!ez&&eM?.structure==="personal"';
  const [dots, billing] = patchLeanPrefetch(fixture).split(";");
  const prefetches = features => {
    const calls = [];
    const t = { e: id => (calls.push(id), Promise.resolve()), bind: () => () => {} };
    run(`${dots}`, ["x", "t", "S"], { $O: { prefetch: () => calls.push("editor") } }, t, { Wy: () => calls.push("routes") }, rendererFeatures(features));
    return calls;
  };
  assert.deepEqual(prefetches(null), ["routes"]);
  assert.deepEqual(prefetches({ dots: true }), ["editor", 846474, "routes"]);
  const personal = features => run(`let eq;${billing};return eq`, ["eT", "eL", "ez", "eM"], "chatgpt", false, false, { structure: "personal" }, rendererFeatures(features));
  assert.equal(personal(null), false);
  assert.equal(personal({ chats: true }), true);
});

test("desktop features, ChatGPT history sync and Codex Micro follow the saved choices in the main process", () => {
  const patched = patchLeanMain(mainFixture);
  assert.ok(patched.startsWith("globalThis.czLeanApp=!0;"));
  const [features, latex, visualize, catalog, micro] = patched.slice("globalThis.czLeanApp=!0;".length).split("\n");
  const desktop = choice => {
    let result;
    run(features, ["f", "s"], value => { result = value; }, { ambientSuggestions: true, dotBrowserUse: true, workCloudAccess: true, deepResearch: true, visualizeLive: true, workspaceDir: "w" }, { czAppFeatures: choice });
    return result;
  };
  assert.deepEqual(desktop(null), { quickChat: true, workspaceDir: "w", ...STRIPPED_DESKTOP_FEATURES, ...WORK_MODE_DESKTOP_FEATURES, ...DOTS_DESKTOP_FEATURES });
  assert.equal(desktop({ workMode: true }).workCloudAccess, true);
  assert.equal(desktop({ workMode: true }).dotBrowserUse, false);
  assert.equal(desktop({ dots: true }).dotBrowserUse, true);
  assert.equal(desktop({ dots: true }).workCloudAccess, false);
  assert.ok(latex.endsWith("isAvailable:()=>!1}") && visualize.endsWith("isAvailable:()=>!1}"));
  const syncs = choice => run(`return function(){let x;${catalog};return x!==void 0}`, ["etM"], class {}, { czAppFeatures: choice })
    .call({ threadCatalogSyncManager: {} });
  assert.equal(syncs(null), false);
  assert.equal(syncs({ workMode: true }), false);
  assert.equal(syncs({ chats: true }), true);
  assert.equal(syncs({ dots: true }), true);
  assert.equal(micro, "async getState(){return this.deviceState}");
});

test("every analytics setting reader sees analytics as off", () => {
  const source = "c=e=>e.analytics?.enabled!==!1,x=n==null||n.analytics?.enabled===!1";
  assert.equal(disableAnalytics(source, "fixture"), "c=e=>!1,x=n==null||!0");
  assert.throws(() => disableAnalytics("no settings here", "fixture"), /updated analytics patch/);
});

const chunk = modules => `export const __rspack_esm_ids=[1];export const __webpack_modules__={${modules.join(",")}};\n//# sourceMappingURL=1.js.map`;
const upsell = 'NeK9(e,t,n){n.d(t,{ModelPickerUpsellModal:()=>C});var r=n("ABep");function C(){return r.x(`a${"}"}b`,/[}]/)}}';
const host = 'ljdr(e,t,r){var l=r("x");r.d(t,{},{WorkspaceDiscoveryAnnouncementHost:function(e){return"}"}})}';
const shared = 'abcd(e,t,n){n.d(t,{ModelPickerUpsellModal:()=>C,useModelPicker:()=>D});function C(){}function D(){}}';
const plain = 'wxyz(e,t,n){n.d(t,{x:()=>1})}';

test("rspack chunks split into modules with their exported names", () => {
  const modules = chunkModules(chunk([upsell, host, plain]));
  assert.deepEqual(modules.map(module => module.names), [["ModelPickerUpsellModal"], ["WorkspaceDiscoveryAnnouncementHost"], ["x"]]);
  assert.equal(chunkModules("const x=1;"), null);
});

test("only modules made entirely of stripped components are stubbed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-lean-chunk-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "chunk.mjs");
  await fs.writeFile(file, stubComponentChunk(chunk([upsell, shared, host, plain])));
  const { __webpack_modules__: modules } = await import(pathToFileURL(file).href);
  const load = id => {
    const exports = {};
    const require = Object.assign(() => { throw new Error("dependency loaded"); }, {
      d: (target, getters = {}, values = {}) => {
        for (const [key, get] of Object.entries(getters)) if (!(key in target)) Object.defineProperty(target, key, { get, enumerable: true });
        for (const [key, value] of Object.entries(values)) if (!(key in target)) Object.defineProperty(target, key, { value, enumerable: true });
      }
    });
    modules[id]({}, exports, require);
    return exports;
  };
  assert.equal(load("NeK9").ModelPickerUpsellModal({}), null);
  assert.equal(load("ljdr").WorkspaceDiscoveryAnnouncementHost({ children: "kept" }), "kept");
  assert.equal(typeof load("abcd").useModelPicker, "function");
  assert.equal(load("wxyz").x, 1);
  assert.equal(stubComponentChunk(chunk([shared, plain])), null);
  assert.equal(stubComponentChunk("const x=1;"), null);
});

test("chunk replacements walk nested asset folders and require every stripped component", async () => {
  const files = { "webview/assets/async/1.js": chunk([upsell]), "webview/assets/2.js": chunk([plain]) };
  const archive = {
    header: { files: { webview: { files: { assets: { files: { async: { files: { "1.js": { size: 10 } } }, "2.js": { size: 10 } } } } } } },
    read: async name => Buffer.from(files[name])
  };
  await assert.rejects(leanChunkReplacements(archive), /WorkspaceDiscoveryAnnouncementHost/);
});

test("pruning a copied desktop removes stripped plugins and keeps coding plugins", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-lean-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundled = path.join(root, "resources", "plugins", "openai-bundled");
  const names = ["codex-app-tools", "browser", ...STRIPPED_BUNDLED_PLUGINS];
  await fs.mkdir(path.join(bundled, ".agents", "plugins"), { recursive: true });
  await fs.writeFile(path.join(bundled, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ name: "openai-bundled", plugins: names.map(name => ({ name })) }));
  for (const name of names) await fs.mkdir(path.join(bundled, "plugins", name), { recursive: true });
  await fs.mkdir(path.join(root, "resources", "skills", "skills", ".curated", "hatch-pet"), { recursive: true });
  await fs.mkdir(path.join(root, "resources", "skills", "skills", ".curated", "keep-me"), { recursive: true });
  await pruneCopiedDesktop(root);
  const marketplace = JSON.parse(await fs.readFile(path.join(bundled, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.name), ["codex-app-tools", "browser"]);
  assert.deepEqual((await fs.readdir(path.join(bundled, "plugins"))).sort(), ["browser", "codex-app-tools"]);
  assert.deepEqual(await fs.readdir(path.join(root, "resources", "skills", "skills", ".curated")), ["keep-me"]);
});
