import fs from "node:fs/promises";
import path from "node:path";
import { replaceOnce } from "./sidebar-performance.mjs";

// CodexZero ships a coding-only desktop. Everything here switches off product
// surfaces at the single place the official app decides they exist, so the
// rest of the bundle keeps running unmodified.

// Capability names resolved by the renderer. Children inherit the parent's
// checks, and every child of `chatgpt` is a ChatGPT product surface.
export const STRIPPED_CAPABILITY = /^(chatgpt|toys|demo-tools)(\.|$)/;

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
  quickChat: false,
  workCloudAccess: false,
  workLocalAccess: false,
  deepResearch: false,
  userWriting: false,
  visualizeLive: false,
  visualizeTreatment: false
};

// Lazily loaded components that only render promotions, product tours or
// non-coding surfaces. Their files are replaced by components that render
// nothing, which also keeps their code from ever loading.
export const STUBBED_COMPONENTS = new Set([
  "AvatarOverlayNativePage",
  "ChatGptAnnouncementCandidates",
  "ChatGptConversationBeaconBanner",
  "ChatGptConversationBeaconSurfaces",
  "ChatGptConversationInlineBeacon",
  "CodexAppHomeBeaconAnnouncementContent",
  "CodexAppHomeBeaconConnectModal",
  "CodexHomeAnnouncements",
  "HomeComposerAnnouncementCandidates",
  "HomeComposerAnnouncements",
  "ImageGen25AnnouncementModal",
  "ModelPickerUpsellModal",
  "PepperOnboardingAnnouncementHost",
  "PepperOnboardingBeaconModal",
  "PetInstallModalHost",
  "PopcornElectronDocumentPanel",
  "PopcornElectronPresentationPanel",
  "PopcornElectronWorkbookPanel",
  "RealtimeVoiceHomeAnnouncementContent",
  "TaskAnnouncementCandidates",
  "WalletOnboardingAnnouncement",
  "WalletOnboardingAnnouncementModal",
  "WorkModePetContent",
  "WorkModeUpsellModal",
  "WorkspaceDiscoveryAnnouncementHost"
]);

export const STRIPPED_BUNDLED_PLUGINS = ["deep-research", "latex", "user-writing", "visualize"];
const STRIPPED_RESOURCES = [
  ["artifact-template-picker"],
  ["skills", "skills", ".curated", "hatch-pet"],
  ["skills", "skills", ".curated", "onboard-new-user"]
];

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
    "let n=qoa[e.name];if(!Goa(n))return{isLoading:!1,isError:!1,isCapable:!1};",
    `let n=qoa[e.name];if(!Goa(n)||${STRIPPED_CAPABILITY}.test(e.name))return{isLoading:!1,isError:!1,isCapable:!1};`);
  // Conversations always use the coding presentation, never Work mode.
  source = replaceOnce(source,
    "cun=sf($,({get:e})=>{let t=e(yy);",
    "cun=sf($,({get:e})=>{return`coding`;let t=e(yy);");
  // The sidebar product label stays "Codex" and no longer offers ChatGPT Work.
  source = replaceOnce(source,
    "{disabled:n,mode:r,navigationHeading:i,onModeSelect:a,workModeAccess:o}=e,s=i!==void 0&&i,",
    "{disabled:n,mode:r,navigationHeading:i,onModeSelect:a,workModeAccess:o}=e,czFixedMode=(n=!0,r=`codex`),s=i!==void 0&&i,");
  // The pet overlay window is no longer created in the background at startup.
  source = replaceOnce(source, "shouldPrewarmAvatarOverlay:t&&!s&&we", "shouldPrewarmAvatarOverlay:!1");
  return disableAnalytics(source, "renderer");
}

export function patchLeanMain(source) {
  source = replaceOnce(source,
    "visualizeTreatment:!1};y(e,c.bundledPluginEligibilityReasons);return}",
    `visualizeTreatment:!1};Object.assign(e,${JSON.stringify(STRIPPED_DESKTOP_FEATURES).replace(/"/g, "")});y(e,c.bundledPluginEligibilityReasons);return}`
      .replace(/:false/g, ":!1"));
  source = replaceOnce(source, "{...n.xl.latex,isAvailable:()=>!0}", "{...n.xl.latex,isAvailable:()=>!1}");
  source = replaceOnce(source, "{...n.xl.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!0}", "{...n.xl.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!1}");
  // ChatGPT conversation history is never fetched into the sidebar catalog.
  source = replaceOnce(source,
    "u=this.threadCatalogSyncManager==null?void 0:new X$e(",
    "u=!0?void 0:new X$e(");
  // Codex Micro hardware support never loads its HID service.
  source = replaceOnce(source,
    "async getState(){let e=await this.getService();e.start();let t=e.getState();return this.syncSessionLockMonitor(t),t}",
    "async getState(){return this.deviceState}");
  return disableAnalytics(source, "main");
}

export function patchLeanBootstrap(source) {
  return disableAnalytics(source, "bootstrap");
}

export function stubComponentChunk(source) {
  const match = source.match(/export\s*\{([^}]*)\}\s*;?\s*(\/\/[^\n]*)?\s*$/);
  if (!match) return null;
  const names = match[1].split(",").map(entry => entry.trim().split(/\s+as\s+/).pop());
  if (names.length === 0 || !names.every(name => STUBBED_COMPONENTS.has(name))) return null;
  return `const czNothing=()=>null;export{${names.map(name => `czNothing as ${name}`).join(",")}};\n`;
}

export async function leanChunkReplacements(archive) {
  const replacements = new Map();
  const found = new Set();
  for (const name of Object.keys(archive.header.files.webview.files.assets.files)) {
    if (!name.endsWith(".js")) continue;
    const entry = archive.header.files.webview.files.assets.files[name];
    if (entry.size > 600000) continue;
    const pathName = `webview/assets/${name}`;
    const stub = stubComponentChunk((await archive.read(pathName)).toString("utf8"));
    if (stub == null) continue;
    replacements.set(pathName, Buffer.from(stub));
    for (const exported of stub.matchAll(/czNothing as (\w+)/g)) found.add(exported[1]);
  }
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
