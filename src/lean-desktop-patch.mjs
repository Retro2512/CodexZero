import fs from "node:fs/promises";
import path from "node:path";
import { replaceOnce } from "./sidebar-performance.mjs";

// CodexZero ships a coding-only desktop. Everything here switches off product
// surfaces at the single place the official app decides they exist, so the
// rest of the bundle keeps running unmodified.

// Capability names resolved by the renderer. Children inherit the parent's
// checks: every child of `chatgpt` is a ChatGPT product surface and every
// child of `orbit` belongs to Dots.
export const STRIPPED_CAPABILITY = /^(chatgpt|orbit|toys|demo-tools)(\.|$)/;

// Optional features switched back on in Settings. The main process reads the
// choice at startup and the renderer gets it from preload.
export const FEATURE_KEYS = ["workMode", "chats", "dots"];
const RENDERER_FEATURES = "globalThis.codexZeroFeatures?.current";
const MAIN_FEATURES = "globalThis.czAppFeatures";
const enabled = (features, key) => `${features}?.${key}===!0`;
const chatGptEnabled = features => `(${enabled(features, "workMode")}||${enabled(features, "chats")})`;

// Desktop features forced off in the main process. Voice, dictation, remote
// control, browser use and computer use stay as they are.
export const STRIPPED_DESKTOP_FEATURES = {
  appshotsEnabled: false,
  artifactSession: false,
  artifactTemplatePicker: false,
  ambientSuggestions: false,
  ambientSuggestionsFeatureDiscovery: false,
  skysight: false,
  sites: false,
  deepResearch: false,
  visualizeLive: false
};
export const WORK_MODE_DESKTOP_FEATURES = { workCloudAccess: false, workLocalAccess: false };
export const DOTS_DESKTOP_FEATURES = { dotBrowserUse: false };
const literal = value => JSON.stringify(value).replace(/"/g, "").replace(/:false/g, ":!1");

// Lazily loaded components that only render promotions, product tours or
// non-coding surfaces. Their modules are replaced by components that render
// only their children, which also keeps their dependencies from running.
export const STUBBED_COMPONENTS = new Set([
  "AvatarOverlayNativePage",
  "ChatGptAnnouncementCandidates",
  "ChatGptConversationBeaconBanner",
  "ChatGptConversationBeaconModalSurface",
  "ChatGptConversationInlineBeaconContent",
  "CodexAppHomeBeaconConnectModal",
  "CodexHomeAnnouncementCandidates",
  "CodexHomeAnnouncements",
  "EnterpriseMigrationAnnouncement",
  "GetPlusHeaderButton",
  "HomeComposerAnnouncementCandidates",
  "HomeComposerAnnouncements",
  "MemoryExpansionAnnouncementHost",
  "MemoryMigrationAnnouncementHost",
  "ModelPickerUpsellModal",
  "NoPaymentTrialExpiryAnnouncement",
  "NoPaymentTrialHeader",
  "NoPaymentTrialHomeBanner",
  "NoPaymentTrialWorkTooltip",
  "PaymentCelebrationAnimation",
  "PepperOnboardingAnnouncementHost",
  "PepperOnboardingBeaconModal",
  "PersonalMigrationAnnouncementHost",
  "PetCreationUpsellModal",
  "PetInstallModalHost",
  "PopcornElectronDocumentPanel",
  "TaskAnnouncementCandidates",
  "WorkModePetContent",
  "WorkModeUpsellModal",
  "WorkspaceDiscoveryAnnouncementHost"
]);

export const STRIPPED_BUNDLED_PLUGINS = ["deep-research", "latex", "visualize"];
const STRIPPED_RESOURCES = [
  ["artifact-template-picker"],
  ["skills", "skills", ".curated", "hatch-pet"],
  ["skills", "skills", ".curated", "onboard-new-user"]
];

// Each patch applies to the one bundle file that contains its target.
export const LEAN_MAIN_TARGET = "threadCatalogSyncManager";
export const LEAN_BOOTSTRAP_TARGET = "CODEX_DESKTOP_NETWORK_POLICY";
export const LEAN_RENDERER_TARGET = "Duplicate capability name: ";
export const LEAN_DESKTOP_FEATURES_TARGET = "browser_use_availability_resolved";
export const LEAN_SIDEBAR_TARGET = "navigationHeading";
export const LEAN_PREFETCH_TARGET = "startup_prefetch";
export const LEAN_CHECKOUT_TARGET = "CheckoutPricingWebviewHost:";

// Every reader of the `[analytics] enabled` setting sees it as off. This
// covers error reporting, log forwarding, product events and worker telemetry.
export function disableAnalytics(source, label) {
  let count = 0;
  const result = source
    .replace(/[\w$]+\.analytics\?\.enabled!==!1/g, () => (count++, "!1"))
    .replace(/[\w$]+\.analytics\?\.enabled===!1/g, () => (count++, "!0"));
  if (count === 0) throw new Error(`This Codex version needs an updated analytics patch (${label})`);
  return result;
}

export function patchLeanRenderer(source) {
  source = replaceOnce(source,
    'let r=p[e.name];if(null==r||!(null==(n=r).supportedClients||n.supportedClients.includes("electron")))return{isLoading:!1,isError:!1,isCapable:!1};',
    `let r=p[e.name];if(null==r||!(null==(n=r).supportedClients||n.supportedClients.includes("electron"))||/^(toys|demo-tools)(\\.|$)/.test(e.name)||!${chatGptEnabled(RENDERER_FEATURES)}&&/^chatgpt(\\.|$)/.test(e.name)||!(${enabled(RENDERER_FEATURES, "dots")})&&/^orbit(\\.|$)/.test(e.name))return{isLoading:!1,isError:!1,isCapable:!1};`);
  // Conversations use the coding presentation and the app stays in its Codex
  // product mode unless Work mode is switched on.
  source = replaceOnce(source,
    '({get:e})=>{let t=e(a.lN);if("denied"===t.status&&"unsupported-auth"===t.reason)return"coding";',
    `({get:e})=>{if(!(${enabled(RENDERER_FEATURES, "workMode")}))return"coding";let t=e(a.lN);if("denied"===t.status&&"unsupported-auth"===t.reason)return"coding";`);
  source = replaceOnce(source,
    "({get:e})=>{let t=(0,u.g4)(e,i.ubS.conversationDetailMode),n=e(o.$T)?.roles;",
    `({get:e})=>{if(!(${enabled(RENDERER_FEATURES, "workMode")}))return"codex";let t=(0,u.g4)(e,i.ubS.conversationDetailMode),n=e(o.$T)?.roles;`);
  // Sites never exists, so its navigation entry, prefetch and access check
  // disappear with it.
  source = replaceOnce(source,
    'enabled:e(o.JW,"637432221"),queryKey:["appgen","access"]',
    'enabled:!1,queryKey:["appgen","access"]');
  source = replaceOnce(source,
    '({get:e})=>{if(!e(o.JW,"637432221"))return"unavailable";',
    '({get:e})=>{return"unavailable";');
  // The ChatGPT file library only exists while a ChatGPT surface is on.
  source = replaceOnce(source,
    '({get:e})=>{let t=e(a.m0);if("loading"===t.status)return"loading";if("allowed"!==t.status)return"unavailable";let n=e(a.chatGptAuthenticatedAccountId$),r=e(l.M9);',
    `({get:e})=>{if(!${chatGptEnabled(RENDERER_FEATURES)})return"unavailable";let t=e(a.m0);if("loading"===t.status)return"loading";if("allowed"!==t.status)return"unavailable";let n=e(a.chatGptAuthenticatedAccountId$),r=e(l.M9);`);
  // Dots pages are only fetched ahead of time when Dots is on.
  source = replaceOnce(source,
    "Wy:async function(){await Promise.all([s.prefetch(),o.prefetch(),l.prefetch(),i.v.prefetch()])}",
    `Wy:async function(){let czDots=${enabled(RENDERER_FEATURES, "dots")};await Promise.all([s.prefetch(),czDots&&o.prefetch(),czDots&&l.prefetch(),i.v.prefetch()])}`);
  return disableAnalytics(source, "renderer");
}

// Nothing is created in the background at startup for surfaces that are off:
// the pet overlay window, the inline visualization sandbox, and the ChatGPT
// response renderer frame unless a ChatGPT surface is on.
export function patchLeanDesktopFeatures(source) {
  source = replaceOnce(source, "shouldPrewarmAvatarOverlay:t&&eT", "shouldPrewarmAvatarOverlay:!1");
  source = replaceOnce(source, 'y=(0,i.jsx)(fy,{phase:"background_ready",children:(0,i.jsx)(gL,{})})', "y=null");
  return replaceOnce(source,
    '"disabled"===e(t)?i.prewarm():i.dispose()',
    `${chatGptEnabled(RENDERER_FEATURES)}&&"disabled"===e(t)?i.prewarm():i.dispose()`);
}

// The embedded ChatGPT pricing and credit checkout pages are only loaded in
// advance while a ChatGPT surface is on. Opening checkout still works.
export function patchLeanCheckout(source) {
  source = replaceOnce(source,
    '!H&&((0,g.$t)()||"chatgpt"!==E||$||null==G||D||T?.structure!=="personal"',
    `!H&&(!${chatGptEnabled(RENDERER_FEATURES)}||(0,g.$t)()||"chatgpt"!==E||$||null==G||D||T?.structure!=="personal"`);
  return replaceOnce(source,
    'm=!(0,g.$t)()&&"chatgpt"===V&&!Z&&null!=Q&&!et&&Y?.structure==="personal"&&',
    `m=${chatGptEnabled(RENDERER_FEATURES)}&&!(0,g.$t)()&&"chatgpt"===V&&!Z&&null!=Q&&!et&&Y?.structure==="personal"&&`);
}

// The sidebar product label stays "Codex" unless a ChatGPT surface is on.
export function patchLeanSidebar(source) {
  return replaceOnce(source,
    '{"aria-describedby":P,codexAvailable:M,disabled:T,mode:E,navigationHeading:N,onModeSelect:L,onNewChat:R,workModeAccess:O}=e,',
    `{"aria-describedby":P,codexAvailable:M,disabled:T,mode:E,navigationHeading:N,onModeSelect:L,onNewChat:R,workModeAccess:O}=e,czFixedMode=${chatGptEnabled(RENDERER_FEATURES)}?0:(T=!0,E="codex",R=void 0),`);
}

// Startup prefetching skips Dots onboarding, the character editor and
// ChatGPT billing details unless those surfaces are on.
export function patchLeanPrefetch(source) {
  source = replaceOnce(source,
    'x.$O.prefetch(),t.e(846474).then(t.bind(t,"w7xK")).catch(()=>void 0),',
    `${enabled(RENDERER_FEATURES, "dots")}&&(x.$O.prefetch(),t.e(846474).then(t.bind(t,"w7xK")).catch(()=>void 0)),`);
  return replaceOnce(source,
    'eq="chatgpt"===eT&&!eL&&!ez&&eM?.structure==="personal"',
    `eq=${chatGptEnabled(RENDERER_FEATURES)}&&"chatgpt"===eT&&!eL&&!ez&&eM?.structure==="personal"`);
}

export function patchLeanMain(source) {
  source = replaceOnce(source,
    "deepResearch:s.deepResearch,visualizeLive:s.visualizeLive,workspaceDir:s.workspaceDir},s.bundledPluginEligibilityReasons)",
    `deepResearch:s.deepResearch,visualizeLive:s.visualizeLive,workspaceDir:s.workspaceDir,...${literal(STRIPPED_DESKTOP_FEATURES)},...${enabled(MAIN_FEATURES, "workMode")}?{}:${literal(WORK_MODE_DESKTOP_FEATURES)},...${enabled(MAIN_FEATURES, "dots")}?{}:${literal(DOTS_DESKTOP_FEATURES)}},s.bundledPluginEligibilityReasons)`);
  source = replaceOnce(source, "{...es.iRL.latex,isAvailable:()=>!0}", "{...es.iRL.latex,isAvailable:()=>!1}");
  source = replaceOnce(source, "{...es.iRL.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!0}", "{...es.iRL.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!1}");
  // ChatGPT conversation history is only fetched when ChatGPT chats or Dots are on.
  source = replaceOnce(source,
    "x=null==this.threadCatalogSyncManager?void 0:new etM(",
    `x=${MAIN_FEATURES}?.chats!==!0&&${MAIN_FEATURES}?.dots!==!0||null==this.threadCatalogSyncManager?void 0:new etM(`);
  // Codex Micro hardware support never loads its HID service.
  source = replaceOnce(source,
    "async getState(){let e=await this.getService();e.start();let t=e.getState();return this.syncSessionLockMonitor(t),t}",
    "async getState(){return this.deviceState}");
  return "globalThis.czLeanApp=!0;" + disableAnalytics(source, "main");
}

export function patchLeanBootstrap(source) {
  return disableAnalytics(source, "bootstrap");
}

export const LEAN_FILE_PATCHES = [
  [LEAN_MAIN_TARGET, patchLeanMain],
  [LEAN_BOOTSTRAP_TARGET, patchLeanBootstrap],
  [LEAN_RENDERER_TARGET, patchLeanRenderer],
  [LEAN_DESKTOP_FEATURES_TARGET, patchLeanDesktopFeatures],
  [LEAN_SIDEBAR_TARGET, patchLeanSidebar],
  [LEAN_PREFETCH_TARGET, patchLeanPrefetch],
  [LEAN_CHECKOUT_TARGET, patchLeanCheckout]
];

// Scan minified code from i to the first character in `stops` outside any
// bracket, string, template or regular expression. Returns -1 when none.
function skip(s, i, stops) {
  const stack = [];
  let prev = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (stack.length === 0 && stops.includes(c)) return i;
    if (c === '"' || c === "'") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
    } else if (c === "`") {
      i = template(s, i + 1, stack);
    } else if (c === "/" && /^$|[(,=:[!&|?{};+\-*%<>~^]$|\b(return|typeof|case|in|of|void)$/.test(prev)) {
      for (let cls = false, j = i + 1; j < s.length; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "[") cls = true;
        else if (s[j] === "]") cls = false;
        else if (s[j] === "/" && !cls) { i = j; break; }
      }
    } else if (c === "{" || c === "(" || c === "[") stack.push(c);
    else if (c === "}" || c === ")" || c === "]") {
      if (stack.pop() === "${") i = template(s, i + 1, stack);
    }
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) && /[\w$]$/.test(prev) ? prev.slice(-8) + c : c;
  }
  return -1;
}

function template(s, i, stack) {
  for (; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "`") return i;
    else if (s[i] === "$" && s[i + 1] === "{") { stack.push("${"); return i + 1; }
  }
  return i;
}

// The modules of an rspack chunk with the names each one exports.
export function chunkModules(s) {
  const head = "export const __webpack_modules__={";
  let i = s.indexOf(head);
  if (i < 0) return null;
  i += head.length;
  const modules = [];
  const key = /("[^"]*"|[\w$]+)\(([\w$]*)(?:,([\w$]+))?(?:,([\w$]+))?\)\{/y;
  while (s[i] !== "}") {
    key.lastIndex = i;
    const match = key.exec(s);
    if (!match) return null;
    const [, , , exports, require] = match;
    const body = key.lastIndex;
    const end = skip(s, body, "}");
    if (end < 0) return null;
    modules.push({ body, end, exports, require, names: require ? exportedNames(s, body, end, `${require}.d(${exports},`) : [] });
    i = end + 1;
    if (s[i] === ",") i++;
    else if (s[i] !== "}") return null;
  }
  return modules;
}

function exportedNames(s, body, end, call) {
  const names = [];
  for (let i = s.indexOf(call, body); i >= 0 && i < end; i = s.indexOf(call, i + 1)) {
    for (let j = i + call.length; s[j] === "{";) {
      const close = skip(s, j + 1, "}");
      for (let k = j + 1; k < close;) {
        const name = /("[^"]*"|[\w$]+)/y;
        name.lastIndex = k;
        const match = name.exec(s);
        if (!match) break;
        names.push(match[1].replace(/"/g, ""));
        const next = skip(s, name.lastIndex, ",}");
        if (next < 0 || next >= close) break;
        k = next + 1;
      }
      j = close + 1;
      if (s[j] === ",") j++;
    }
  }
  return names;
}

const STUB_HINT = new RegExp(`[{,](${[...STUBBED_COMPONENTS].join("|")}):`);

// Modules that export nothing but stripped components return before running
// their code or loading their dependencies.
export function stubComponentChunk(source) {
  if (!STUB_HINT.test(source)) return null;
  const modules = chunkModules(source);
  if (modules == null) return null;
  let result = source;
  for (const { body, exports, require, names } of modules.reverse()) {
    if (names.length === 0 || !names.every(name => STUBBED_COMPONENTS.has(name))) continue;
    const stub = `const czNothing=e=>e?.children??null;${require}.d(${exports},{${names.map(name => `${name}:()=>czNothing`).join(",")}});return;`;
    result = result.slice(0, body) + stub + result.slice(body);
  }
  return result === source ? null : result;
}

export async function leanChunkReplacements(archive) {
  const replacements = new Map();
  const found = new Set();
  async function walk(files, prefix) {
    for (const [name, entry] of Object.entries(files)) {
      const pathName = `${prefix}/${name}`;
      if (entry.files) await walk(entry.files, pathName);
      else if (name.endsWith(".js") && entry.size <= 3000000) {
        const stubbed = stubComponentChunk((await archive.read(pathName)).toString("utf8"));
        if (stubbed == null) continue;
        replacements.set(pathName, Buffer.from(stubbed));
        for (const [, names] of stubbed.matchAll(/\.d\([\w$]+,\{([^}]*:\(\)=>czNothing)\}\);return;/g)) {
          for (const entry of names.split(",")) found.add(entry.split(":")[0]);
        }
      }
    }
  }
  await walk(archive.header.files.webview.files.assets.files, "webview/assets");
  const missing = [...STUBBED_COMPONENTS].filter(name => !found.has(name));
  if (missing.length > 0) throw new Error(`This Codex version needs an updated lean desktop patch: ${missing.join(", ")}`);
  return replacements;
}

// Remove bundled plugins and skills that only serve stripped surfaces from a
// copied desktop application. The installed app is never touched.
export async function pruneCopiedDesktop(appRoot) {
  const resources = path.join(appRoot, "resources");
  const bundled = path.join(resources, "plugins", "openai-bundled");
  const marketplaceDir = path.join(bundled, ".agents", "plugins");
  for (const file of await fs.readdir(marketplaceDir)) {
    const target = path.join(marketplaceDir, file);
    const marketplace = JSON.parse(await fs.readFile(target, "utf8"));
    if (!Array.isArray(marketplace.plugins)) continue;
    marketplace.plugins = marketplace.plugins.filter(plugin => !STRIPPED_BUNDLED_PLUGINS.includes(plugin.name));
    await fs.writeFile(target, JSON.stringify(marketplace, null, 2) + "\n");
  }
  for (const name of STRIPPED_BUNDLED_PLUGINS) {
    await fs.rm(path.join(bundled, "plugins", name), { recursive: true, force: true });
  }
  for (const parts of STRIPPED_RESOURCES) {
    await fs.rm(path.join(resources, ...parts), { recursive: true, force: true });
  }
}
