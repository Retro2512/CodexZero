import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openAsar, rewriteAsar } from "./asar-patch.mjs";
import { codexZeroHome } from "./paths.mjs";

export async function prepareNativeProviderDesktop(installedDesktop, { home = codexZeroHome() } = {}) {
  if (process.platform !== "win32") throw new Error("Native custom model settings currently require the Windows local build");
  const source = path.resolve(import.meta.dirname, "..");
  const hash = createHash("sha256");
  const packageBytes = await fs.readFile(path.join(source, "package.json"));
  hash.update(packageBytes);
  hash.update(installedDesktop);
  hash.update(String((await fs.stat(path.join(path.dirname(installedDesktop), "resources", "app.asar"))).mtimeMs));
  const files = [];
  for (const folder of ["src", "bin", "assets", "scripts"]) {
    for (const name of (await fs.readdir(path.join(source, folder))).sort()) {
      const file = path.join(folder, name);
      if (!(await fs.stat(path.join(source, file))).isFile()) continue;
      files.push(file);
      hash.update(file); hash.update(await fs.readFile(path.join(source, file)));
    }
  }
  const root = path.join(home, "native-provider-builds", hash.digest("hex").slice(0, 20));
  const manifest = path.join(root, "native-build.json");
  try { return JSON.parse(await fs.readFile(manifest, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), packageBytes);
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(root, file));
  }
  const { prepareProviderLauncher } = await import(pathToFileURL(path.join(root, "src", "provider-launcher.mjs")).href);
  const runtime = await prepareProviderLauncher(installedDesktop, { home: root });
  const desktopBinary = await buildNativeProviderApp(installedDesktop, root);
  await fs.writeFile(path.join(root, "local-build.json"), JSON.stringify({
    desktopBinary, core: path.relative(root, runtime.core), launcher: path.relative(root, runtime.launcher)
  }));
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-File",
    path.join(source, "scripts", "build-codexzero-launcher.ps1"), "-BuildRoot", root], { windowsHide: true });
  const result = { ...runtime, desktopBinary, application: path.join(root, "CodexZero.exe") };
  await fs.writeFile(manifest, JSON.stringify(result));
  return result;
}

export async function buildNativeProviderApp(installedDesktop, outputRoot) {
  const installedRoot = path.dirname(installedDesktop);
  const archivePath = path.join(installedRoot, "resources", "app.asar");
  const archive = await openAsar(archivePath);
  const assets = path.resolve(import.meta.dirname, "..", "assets");
  const replacements = new Map();
  try {
    const agentFiles = Object.keys(archive.header.files.webview.files.assets.files).filter(name => /^agent-settings-[\w]+\.js$/.test(name));
    if (agentFiles.length !== 1) throw new Error("This Codex version needs an updated Settings patch");
    const agentPath = `webview/assets/${agentFiles[0]}`;
    let agent = (await archive.read(agentPath)).toString("utf8");
    const anchor = "children:[d,f,h,_]";
    if (agent.split(anchor).length !== 2 || !agent.includes("Kr();export{br as AgentSettings}") || !agent.includes("zr.useState")) {
      throw new Error("This Codex version needs an updated Settings patch");
    }
    agent = 'import{createCacheSettings as czCreateCacheSettings}from"./codexzero-cache-ui.js";import{createProviderSettings as czCreateProviderSettings}from"./codexzero-provider-settings.js";' + agent;
    agent = agent.replace(anchor, "children:[(0,$.jsx)(CodexZeroProviders,{hostId:t}),(0,$.jsx)(CodexZeroCacheSettings,{hostId:t}),d,f,h,_]");
    agent = agent.replace("Kr();export{br as AgentSettings}", "Kr();const CodexZeroProviders=czCreateProviderSettings(zr,$,q),CodexZeroCacheSettings=czCreateCacheSettings(zr,q);export{br as AgentSettings}");
    replacements.set(agentPath, Buffer.from(agent));
    replacements.set("webview/assets/codexzero-provider-settings.js", await fs.readFile(path.join(assets, "native-provider-settings.mjs")));
    replacements.set("webview/assets/codexzero-cache-ui.js", await fs.readFile(path.join(assets, "native-cache-ui.mjs")));
    const primaryName = Object.keys(archive.header.files.webview.files.assets.files).find(name => /^app-primary-[\w]+\.js$/.test(name));
    if (!primaryName) throw new Error("This Codex version needs an updated context indicator patch");
    const primaryPath = `webview/assets/${primaryName}`;
    let primary = (await archive.read(primaryPath)).toString("utf8");
    primary = patchCacheIndicator(primary);
    replacements.set(primaryPath, Buffer.from(primary));
    const early = await archive.read(".vite/build/early-bootstrap.js");
    replacements.set(".vite/build/early-bootstrap.js", Buffer.concat([Buffer.from('require("./codexzero-provider-main.cjs");require("./codexzero-identity.cjs");\n'), early]));
    replacements.set(".vite/build/codexzero-provider-main.cjs", await fs.readFile(path.join(assets, "native-provider-main.cjs")));
    replacements.set(".vite/build/codexzero-identity.cjs", await fs.readFile(path.join(assets, "native-provider-identity.cjs")));
    const bootstrapName = Object.keys(archive.header.files[".vite"].files.build.files).find(name => /^bootstrap-[\w-]+\.js$/.test(name));
    if (!bootstrapName) throw new Error("This Codex version needs an updated desktop identity patch");
    let bootstrap = (await archive.read(`.vite/build/${bootstrapName}`)).toString("utf8");
    bootstrap = patchNativeUpdater(bootstrap);
    for (const name of ["native-provider-updater.cjs", "native-provider-update-release.cjs"]) {
      replacements.set(`.vite/build/${name}`, await fs.readFile(path.join(assets, name)));
    }
    const { version } = JSON.parse(await fs.readFile(path.join(assets, "..", "package.json"), "utf8"));
    replacements.set(".vite/build/codexzero-update-version.json", Buffer.from(JSON.stringify({ version })));
    for (const [before, after] of [
      ["o.app.setAppUserModelId(Ut(_j))", 'o.app.setAppUserModelId("CodexZero.Desktop")'],
      ["o.app.setName(n.Eo(_j))", 'o.app.setName("CodexZero")']
    ]) {
      if (bootstrap.split(before).length !== 2) throw new Error("This Codex version needs an updated desktop identity patch");
      bootstrap = bootstrap.replace(before, after);
    }
    replacements.set(`.vite/build/${bootstrapName}`, Buffer.from(bootstrap));
    replacements.set(".vite/build/preload.js", Buffer.concat([await archive.read(".vite/build/preload.js"), Buffer.from("\n"), await fs.readFile(path.join(assets, "native-provider-preload.cjs"))]));
  } finally { await archive.close(); }
  const appRoot = path.join(outputRoot, "desktop");
  // Build a separate app copy. Never patch the installed application or executable.
  await fs.cp(installedRoot, appRoot, {
    recursive: true, force: false, errorOnExist: true,
    filter: source => source !== archivePath
  });
  const patchedArchive = path.join(appRoot, "resources", "app.asar");
  await rewriteAsar(archivePath, patchedArchive, replacements);
  const verify = await openAsar(patchedArchive);
  try {
    for (const [name, expected] of replacements) {
      if (!(await verify.read(name)).equals(expected)) throw new Error("The native Settings build failed verification");
    }
  } finally { await verify.close(); }
  return path.join(appRoot, path.basename(installedDesktop));
}

export function patchNativeUpdater(source) {
  const anchor = "sparkleManager:new KT({";
  if (source.split(anchor).length !== 2) throw new Error("This Codex version needs an updated updater patch");
  return source.replace(anchor, 'sparkleManager:new(require("./native-provider-updater.cjs").CodexZeroUpdater)({');
}

export function patchCacheIndicator(source) {
  const start = source.indexOf("function VYe(e){");
  const end = source.indexOf("function HYe(e){", start);
  const footer = "let W;t[22]!==v||t[23]!==H?(W=H?(0,M3.jsx)(`span`,{ref:E,className:`text-sm leading-[18px]`,children:(0,M3.jsx)(VYe,{contextUsage:v})}):null,t[22]=v,t[23]=H,t[24]=W):W=t[24];";
  if (start < 0 || end < start || source.split(footer).length !== 2 || !source.includes("j3=X()")) throw new Error("This Codex version needs an updated context indicator patch");
  let result = source.slice(0, start) + "function VYe(e){czCacheIndicator??=czCreateCacheIndicator(X());return(0,Z4.jsx)(czCacheIndicator,e)}" + source.slice(end);
  // Avoid reusing a memoized indicator from a different task with equal context usage.
  result = result.replace(footer, "let W=H?(0,M3.jsx)(`span`,{ref:E,className:`text-sm leading-[18px]`,children:(0,M3.jsx)(VYe,{contextUsage:v,threadId:m,hostId:o})}):null;");
  return 'import{createCacheIndicator as czCreateCacheIndicator}from"./codexzero-cache-ui.js";let czCacheIndicator;' + result;
}
