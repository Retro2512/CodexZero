import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export const appRoot = process.env.CODEXZERO_TEST_APP || "work/upstream-26.1103/app";
export const bundledAvailable = fs.existsSync(appRoot);

// Each target names the one bundled file a patch applies to.
const sources = new Map(), files = new Map();
export const bundledPath = target => files.get(target);
export function bundledSources(targets) {
  const missing = Object.values(targets).filter(target => !sources.has(target));
  const visit = dir => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!missing.length) return;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) { visit(file); continue; }
      if (!/\.(c?js|mjs)$/.test(item.name)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const target of [...missing]) if (source.includes(target)) { sources.set(target, source); files.set(target, path.relative(appRoot, file).replaceAll("\\", "/")); missing.splice(missing.indexOf(target), 1); }
    }
  };
  if (missing.length) { visit(path.join(appRoot, ".vite/build")); visit(path.join(appRoot, "webview/assets")); }
  assert.deepEqual(missing, [], "Missing bundled patch targets");
  return Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, sources.get(target)]));
}

// Minified bundles keep strings and templates; braces inside them are skipped.
export function blockEnd(source, from) {
  for (let i = source.indexOf("{", from), depth = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' || c === "'") { for (i++; source[i] !== c; i++) if (source[i] === "\\") i++; }
    else if (c === "`") i = templateEnd(source, i);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  throw new Error("Unbalanced bundled block");
}
function templateEnd(source, i) {
  for (i++; source[i] !== "`"; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "$" && source[i + 1] === "{") i = blockEnd(source, i + 1) - 1;
  }
  return i;
}

// Minified names repeat across bundled modules, so the nearest declaration wins.
export function definition(source, name, near = 0) {
  const nearest = token => { let best = -1; for (let i = source.indexOf(token); i >= 0; i = source.indexOf(token, i + 1)) if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i; return best; };
  let i = nearest(`function ${name}(`);
  if (i >= 0) return source.slice(source.startsWith("async ", i - 6) ? i - 6 : i, blockEnd(source, source.indexOf(")", i)));
  i = nearest(`class ${name}{`);
  if (i >= 0) return source.slice(i, blockEnd(source, i));
  i = nearest(`${name}=\``);
  assert.ok(i >= 0, `Missing bundled definition: ${name}`);
  return `const ${name}=${source.slice(i + name.length + 1, templateEnd(source, i + name.length + 1) + 1)}`;
}

// Bundled code runs against explicit stand-ins; any other free name fails loudly.
export function evaluate(code, context, result) {
  const scope = new Proxy(context, { has: (target, key) => typeof key === "string" && !(key in globalThis) || key in target,
    get: (target, key) => { if (key in target) return target[key]; if (key === Symbol.unscopables) return undefined; throw new ReferenceError(`Unexpected bundled reference: ${String(key)}`); } });
  return new Function("scope", `with(scope){${code};return ${result};}`)(scope);
}
