import { PALETTES, CATEGORIES, validateDrawing, validateImage, deterministicIdentity } from "./codexzero-sidebar-schema.js";

const STYLE_ID = "codexzero-sidebar-identity-style";
const CSS = `
[data-czsi-project] { --czsi-hue: var(--czsi-light); background: color-mix(in srgb, var(--czsi-hue) 5%, transparent); border-radius: 8px; margin-bottom: 8px; }
[data-czsi-project] [data-czsi-project-title], [data-czsi-project] [data-app-action-sidebar-project-row] span.select-none { font-family: Bahnschrift, "Segoe UI Variable Display", "Segoe UI", sans-serif; font-size: 14px; font-weight: 650; letter-spacing: .1px; }
[data-czsi-project] [data-czsi-thread] [data-app-action-sidebar-thread-row] { margin-left: 20px; width: calc(100% - 20px); }
[data-czsi-thread] { --czsi-title: var(--czsi-title-light); }
[data-czsi-thread] [data-thread-title] { color: var(--czsi-title); }
[data-czsi-thread] [data-app-action-sidebar-thread-active="true"] [data-thread-title], [data-czsi-thread] [data-app-action-sidebar-thread-selected="true"] [data-thread-title] { font-weight: 600; }
[data-czsi-thread] [data-app-action-sidebar-thread-active="true"], [data-czsi-thread] [data-app-action-sidebar-thread-selected="true"] { position: relative; background: color-mix(in srgb, currentColor 11%, transparent); }
[data-czsi-thread] [data-app-action-sidebar-thread-active="true"]::before, [data-czsi-thread] [data-app-action-sidebar-thread-selected="true"]::before { content: ""; position: absolute; left: 0; top: calc(50% - 8px); width: 2px; height: 16px; border-radius: 2px; background: currentColor; }
.dark [data-czsi-project], [data-theme="dark"] [data-czsi-project] { --czsi-hue: var(--czsi-dark); }
.dark [data-czsi-thread], [data-theme="dark"] [data-czsi-thread] { --czsi-title: var(--czsi-title-dark); }
.dark [data-czsi-project-icon], [data-theme="dark"] [data-czsi-project-icon] { --czsi-hue: var(--czsi-dark); }
.czsi-icon { display: inline-flex; width: 20px; height: 20px; flex: none; align-items: center; justify-content: center; color: var(--czsi-hue, currentColor); }
.czsi-icon svg { width: 100%; height: 100%; display: block; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.czsi-icon img { width: 100%; height: 100%; display: block; object-fit: contain; }
.czsi-thread-icon { width: 17px; height: 17px; color: var(--czsi-title, currentColor); }
.czsi-editor { display: grid; gap: 12px; margin: 14px 0 4px; color: inherit; font: inherit; }
.czsi-editor fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.czsi-editor legend { padding: 0; margin-bottom: 6px; font-size: 12px; font-weight: 600; }
.czsi-options { display: flex; flex-wrap: wrap; gap: 6px; }
.czsi-choice { width: 32px; height: 32px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px; background: transparent; color: inherit; display: grid; place-items: center; padding: 4px; cursor: pointer; }
.czsi-choice[aria-pressed="true"] { border-color: currentColor; background: color-mix(in srgb, currentColor 9%, transparent); }
.czsi-choice:focus-visible, .czsi-upload:focus-within { outline: 2px solid currentColor; outline-offset: 2px; }
.czsi-choice svg { width: 19px; height: 19px; }
.czsi-color { width: 36px; height: 32px; border: 0; padding: 0; background: transparent; cursor: pointer; }
.czsi-upload { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 8px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 6px; font-size: 12px; cursor: pointer; }
.czsi-upload input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.czsi-check { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.czsi-error { color: var(--color-text-danger, #b54242); font-size: 12px; }
`;

let reactContext;
let editorContext;
const memoThreadComponents = new WeakMap();
const memoProjectIconComponents = new WeakMap();
function memoized(React, component, cache) {
  let result = cache.get(React);
  if (!result) cache.set(React, result = React.memo(component));
  return result;
}
function contexts(React) {
  reactContext ??= React.createContext(null);
  editorContext ??= React.createContext(null);
  return [reactContext, editorContext];
}
function installStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
function key(kind, id, hostId) { return JSON.stringify([hostId || "local", kind, id]); }
const records = new Map();
const listeners = new Map();
const hydrationListeners = new Set();
const observations = new Map();
const sentObservations = new Map();
let hydrated = false;
let hydration;
let subscribed = false;
let observeTimer;
let snapshotGeneration = 0;
function api() { return globalThis.window?.codexZeroAppearance; }
function publish(k) { for (const callback of listeners.get(k) || []) callback(); }
function put(k, record) { records.set(k, record || null); publish(k); }
function refresh() {
  const bridge = api();
  const generation = ++snapshotGeneration;
  hydrated = false;
  for (const callback of hydrationListeners) callback();
  const oldKeys = [...records.keys()];
  records.clear();
  for (const k of oldKeys) publish(k);
  for (const [k, value] of sentObservations) observations.set(k, value);
  sentObservations.clear();
  if (observations.size && !observeTimer) observeTimer = setTimeout(flushObservations, 100);
  hydration = Promise.resolve(bridge?.snapshot?.()).then(data => {
    if (generation !== snapshotGeneration) return;
    if (data?.records) for (const [k, record] of Object.entries(data.records)) {
      if ((records.get(k)?.revision || 0) <= (record?.revision || 0)) records.set(k, record);
    }
    hydrated = true;
    for (const callback of hydrationListeners) callback();
    for (const k of new Set([...oldKeys, ...records.keys()])) publish(k);
  }).catch(() => { if (generation === snapshotGeneration) { hydrated = true; for (const callback of hydrationListeners) callback(); } });
  return hydration;
}
function boot() {
  const bridge = api();
  if (!bridge) return;
  if (!subscribed) {
    subscribed = true;
    bridge.subscribe?.(event => { if (event?.reset) { refresh(); return; } if (event?.key) put(event.key, event.record); });
  }
  if (!hydration) refresh();
}
function flushObservations() {
  observeTimer = undefined;
  const batch = [];
  for (const [k, value] of observations) {
    observations.delete(k);
    sentObservations.set(k, value);
    batch.push(JSON.parse(value));
    if (batch.length === 100) break;
  }
  while (sentObservations.size > 5000) sentObservations.delete(sentObservations.keys().next().value);
  if (observations.size) observeTimer = setTimeout(flushObservations, 100);
  Promise.resolve(api()?.observe?.(batch)).catch(() => {});
}
function observe(entity) {
  if (!entity?.id) return;
  const k = key(entity.kind, entity.id, entity.hostId);
  const normalized = { kind: entity.kind, id: entity.id, hostId: entity.hostId || "local", title: entity.title || "", cwd: entity.cwd || "", projectId: entity.projectId || undefined };
  const serialized = JSON.stringify(normalized);
  if (observations.get(k) === serialized) return;
  if (sentObservations.get(k) === serialized) { observations.delete(k); return; }
  observations.set(k, serialized);
  if (!observeTimer) observeTimer = setTimeout(flushObservations, 100);
}
function useIdentity(React, entity, register = true) {
  boot();
  const k = key(entity.kind, entity.id, entity.hostId);
  React.useEffect(() => { if (register) observe(entity); }, [register, k, entity.title, entity.cwd, entity.projectId]);
  const subscribe = React.useCallback(callback => {
    let set = listeners.get(k);
    if (!set) listeners.set(k, set = new Set());
    set.add(callback);
    return () => { set.delete(callback); if (!set.size) listeners.delete(k); };
  }, [k]);
  const get = React.useCallback(() => records.get(k) || null, [k]);
  return React.useSyncExternalStore(subscribe, get, get);
}
function useHydrated(React) {
  boot();
  return React.useSyncExternalStore(callback => { hydrationListeners.add(callback); return () => hydrationListeners.delete(callback); }, () => hydrated, () => hydrated);
}
function palette(id) { return PALETTES.find(p => p.id === id) || PALETTES[0]; }
function rgb(hex) { return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)); }
function hex(channels) { return `#${channels.map(channel => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("").toUpperCase()}`; }
function mix(a, b, amount) { const x = rgb(a), y = rgb(b); return hex(x.map((value, index) => value * (1 - amount) + y[index] * amount)); }
function luminance(color) {
  const channels = rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
export function contrastRatio(first, second) { const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
function readable(color, backgrounds, target, anchor) {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, anchor, step / 100);
    if (backgrounds.every(background => contrastRatio(candidate, background) >= target)) return candidate;
  }
  return anchor;
}
function familyColors(ident) {
  const p = palette(ident?.palette);
  const source = /^#[0-9a-fA-F]{6}$/.test(ident?.color || "") ? ident.color : p.light;
  const light = readable(source, ["#FAF9F7", "#E3E3E7", mix(source, "#FAF9F7", .95)], 3, "#20232A");
  const darkSource = source.toUpperCase() === p.light.toUpperCase() ? p.dark : mix(source, "#F4F3F5", .38);
  const dark = readable(darkSource, ["#191A1C", "#393A40", mix(darkSource, "#191A1C", .95)], 3, "#F4F3F5");
  return { light, dark };
}
export function resolveColors(ident, parent) {
  const family = familyColors(parent || ident);
  const tone = Number.isInteger(ident?.tone) && ident.tone >= 0 && ident.tone <= 3 ? ident.tone : 0;
  const strengths = [.4, .48, .56, .64];
  const light = readable(mix("#20232A", family.light, strengths[tone]), ["#FAF9F7", "#E3E3E7", mix(family.light, "#FAF9F7", .95)], 4.5, "#20232A");
  const dark = readable(mix("#F4F3F5", family.dark, strengths[tone]), ["#191A1C", "#393A40", mix(family.dark, "#191A1C", .95)], 4.5, "#F4F3F5");
  return { light, dark, familyLight: family.light, familyDark: family.dark };
}
function identity(kind, id, hostId, title, record, parent) {
  const fallback = deterministicIdentity(key(kind, id, hostId), { title, parent });
  return { ...fallback, ...record };
}
function colors(ident, parent) {
  const p = resolveColors(ident, parent);
  return { "--czsi-light": p.familyLight, "--czsi-dark": p.familyDark,
    "--czsi-title-light": p.light, "--czsi-title-dark": p.dark };
}

const CATEGORY_PATHS = {
  fix: ["M9 5 15 5 M8 8 16 8 M7 10 7 16 A5 5 0 0 0 17 16 L17 10 M9 20 9 17 M15 20 15 17 M4 11 7 12 M17 12 20 11 M4 17 7 16 M17 16 20 17", "M9 8 Q12 7 15 8"],
  feature: ["M4 5 L11 5 L11 12 L4 12 Z M13 12 L20 12 L20 19 L13 19 Z M12 7 L17 7 L17 11 M7 13 L7 17 L12 17"],
  question: ["M12 21 A9 9 0 1 0 12 3 A9 9 0 1 0 12 21", "M9 9 A3 3 0 1 1 14 11 L12 13 L12 15", "M12 18 L12 18"],
  chat: ["M5 5 L19 5 Q21 5 21 7 L21 16 Q21 18 19 18 L10 18 L5 21 L5 18 Q3 18 3 16 L3 7 Q3 5 5 5 Z", "M7 10 L17 10 M7 14 L14 14"],
  research: ["M5 3 L14 3 L17 6 L17 10 M14 3 L14 6 L17 6 M5 3 L5 18 L11 18", "M16 19 A4 4 0 1 0 16 11 A4 4 0 1 0 16 19 M19 18 L22 21"],
  design: ["M12 3 L18 12 L12 21 L6 12 Z", "M6 12 L18 12 M12 12 L12 17", "M12 17 L12 17"],
  refactor: ["M4 7 L17 7 L14 4 M17 7 L14 10 M20 17 L7 17 L10 14 M7 17 L10 20", "M7 12 L17 12"],
  test: ["M5 4 L19 4 Q20 4 20 5 L20 19 Q20 20 19 20 L5 20 Q4 20 4 19 L4 5 Q4 4 5 4 Z", "M8 12 L11 15 L16 9"],
};
const PROJECT_PATHS = ["M3 6 L10 6 L12 8 L21 8 L21 19 L3 19 Z"];
function glyph(React, kind, drawing, id, className = "") {
  const paths = kind === "project" ? PROJECT_PATHS : CATEGORY_PATHS[kind] || CATEGORY_PATHS.chat;
  const nodes = drawing?.shapes ? drawing.shapes.map((shape, i) => {
    const props = { key: i, fill: shape.fill || "none", stroke: shape.stroke || "currentColor" };
    for (const [k, v] of Object.entries(shape)) if (!["type", "fill", "stroke"].includes(k)) props[k] = v;
    return React.createElement(shape.type, props);
  }) : paths.map((d, i) => React.createElement("path", { key: i, d }));
  return React.createElement("span", { className: `czsi-icon ${className}`, "aria-hidden": "true" },
    React.createElement("svg", { viewBox: "0 0 24 24", focusable: "false" }, ...nodes));
}
function assetIcon(React, image, className = "") {
  return React.createElement("span", { className: `czsi-icon ${className}`, "aria-hidden": "true" },
    React.createElement("img", { src: image, alt: "", draggable: false }));
}
function iconFor(React, current, kind, id, className = "") {
  return current.iconMode === "asset" && current.image
    ? assetIcon(React, current.image, className)
    : glyph(React, current.iconMode === "custom" ? "custom" : kind, current.iconMode === "custom" ? current.drawing : null, id, className);
}

export function projectElement(React, group, child) {
  installStyle();
  return React.createElement(ProjectComponent, { React, group, child, key: group.projectId });
}
function ProjectComponent({ React, group, child }) {
  const [ProjectContext] = contexts(React);
  const entity = { kind: "project", id: group.projectId, hostId: group.hostId || "local", title: group.label || "", cwd: group.path || "" };
  const record = useIdentity(React, entity);
  const current = React.useMemo(() => identity("project", group.projectId, entity.hostId, entity.title, record), [group.projectId, entity.hostId, entity.title, record]);
  const p = React.useMemo(() => familyColors(current), [current]);
  const value = React.useMemo(() => ({ ...current, id: group.projectId, hostId: entity.hostId }), [current, group.projectId, entity.hostId]);
  const content = React.isValidElement(child) ? React.cloneElement(child, {
    "data-czsi-project": group.projectId,
    style: { ...child.props.style, "--czsi-light": p.light, "--czsi-dark": p.dark },
  }) : child;
  return React.createElement(ProjectContext.Provider, { value }, content);
}

export function projectIcon(React, projectId, fallback) {
  return projectId ? React.createElement(memoized(React, ProjectIconComponent, memoProjectIconComponents), { React, projectId }) : fallback;
}
function ProjectIconComponent({ React, projectId }) {
  const [ProjectContext] = contexts(React);
  const inherited = React.useContext(ProjectContext);
  const entity = { kind: "project", id: projectId, hostId: inherited?.hostId || "local", title: "" };
  const record = useIdentity(React, entity, false);
  const current = React.useMemo(() => identity("project", projectId, entity.hostId, "", record || inherited), [projectId, entity.hostId, record, inherited]);
  const p = React.useMemo(() => familyColors(current), [current]);
  const icon = React.useMemo(() => iconFor(React, current, record?.origins?.category === "manual" && current.iconMode === "preset" ? current.category : "project", projectId), [React, current, record?.origins?.category, projectId]);
  return React.createElement("span", { "data-czsi-project-icon": "", style: { "--czsi-hue": p.light, "--czsi-dark": p.dark } },
    icon);
}

export function threadElement(React, NativeComponent, props) {
  installStyle();
  return React.createElement(memoized(React, ThreadComponent, memoThreadComponents), { React, NativeComponent, props, key: props.conversationId });
}
function ThreadComponent({ React, NativeComponent, props }) {
  const [ProjectContext] = contexts(React);
  const parent = React.useContext(ProjectContext);
  const id = props.conversationId;
  const hostId = props.hostId || "local";
  const summary = props.threadSummary || {};
  const entity = { kind: "thread", id, hostId, title: summary.title || "", cwd: summary.cwd || "", projectId: props.hoverCardProjectId || parent?.id };
  const record = useIdentity(React, entity);
  const projectEntity = { kind: "project", id: entity.projectId, hostId, title: "" };
  const projectRecord = useIdentity(React, projectEntity, false);
  const effectiveParent = React.useMemo(() => parent || (entity.projectId ? { ...identity("project", entity.projectId, hostId, "", projectRecord), id: entity.projectId } : null), [parent, entity.projectId, hostId, projectRecord]);
  const current = React.useMemo(() => identity("thread", id, hostId, entity.title, record, effectiveParent), [id, hostId, entity.title, record, effectiveParent]);
  const useCustom = !effectiveParent || effectiveParent.customThreadIcons || record?.origins?.drawing === "manual" || record?.origins?.iconMode === "manual";
  const icon = React.useMemo(() => iconFor(React, useCustom ? current : { ...current, iconMode: "preset" }, current.category, id, "czsi-thread-icon"), [React, current, useCustom, id]);
  const styles = React.useMemo(() => colors(current, record?.origins?.color === "manual" ? null : effectiveParent), [current, record?.origins?.color, effectiveParent]);
  return React.createElement("div", { "data-czsi-thread": id, style: { display: "contents", ...styles } },
    React.createElement(NativeComponent, { ...props, icon }));
}

export function parseSvgDrawing(source) {
  if (typeof source !== "string" || source.length > 8192) throw new TypeError("SVG is too large");
  if (/<!DOCTYPE|<!ENTITY|<\?/.test(source)) throw new TypeError("Unsupported SVG content");
  if (typeof DOMParser === "undefined") throw new TypeError("SVG parser is unavailable");
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg" || root.querySelector("parsererror")) throw new TypeError("Invalid SVG");
  const allowedRoot = new Set(["xmlns", "viewBox", "width", "height"]);
  for (const attr of root.attributes) if (!allowedRoot.has(attr.name)) throw new TypeError("Unsupported SVG attribute");
  for (const field of ["width", "height"]) if (root.hasAttribute(field) && !/^24(?:\.0+)?$/.test(root.getAttribute(field))) throw new TypeError("SVG dimensions must be 24");
  if (root.getAttribute("viewBox") && !/^0(?:\.0+)?[ ,]+0(?:\.0+)?[ ,]+24(?:\.0+)?[ ,]+24(?:\.0+)?$/.test(root.getAttribute("viewBox").trim())) throw new TypeError("SVG must use a 24 by 24 view box");
  const shapeAttrs = { path: ["d", "fill", "stroke"], circle: ["cx", "cy", "r", "fill", "stroke"], rect: ["x", "y", "width", "height", "rx", "fill", "stroke"], line: ["x1", "y1", "x2", "y2", "fill", "stroke"] };
  const shapes = [];
  for (const node of root.childNodes) {
    if (node.nodeType === 3 && !node.textContent.trim()) continue;
    if (node.nodeType !== 1 || node.namespaceURI !== root.namespaceURI || !shapeAttrs[node.localName]) throw new TypeError("Unsupported SVG content");
    if (node.childNodes.length) throw new TypeError("Nested SVG content is unsupported");
    const shape = { type: node.localName };
    for (const attr of node.attributes) {
      if (!shapeAttrs[node.localName].includes(attr.name)) throw new TypeError("Unsupported SVG attribute");
      shape[attr.name] = ["fill", "stroke", "d"].includes(attr.name) ? attr.value : Number(attr.value);
    }
    shapes.push(shape);
  }
  return validateDrawing({ shapes });
}

export function editorSession(React, props, NativeComponent) {
  if (!(props.czId || props.id || props.projectId || props.metadataThreadId || props.conversationId)) {
    const { czKind, czId, czHostId, ...nativeProps } = props;
    return React.createElement(NativeComponent, nativeProps);
  }
  return React.createElement(EditorSessionComponent, { React, props, NativeComponent });
}
function EditorSessionComponent({ React, props, NativeComponent }) {
    const [, EditorContext] = contexts(React);
    const kind = props.czKind || props.kind || (props.projectId ? "project" : "thread");
    const id = props.czId || props.id || props.projectId || props.metadataThreadId || props.conversationId;
    const hostId = props.czHostId || props.hostId || "local";
    const entity = { kind, id, hostId, title: props.title || "" };
    const record = useIdentity(React, entity, false);
    const ready = useHydrated(React);
    const [patch, setPatch] = React.useState({});
    const [error, setError] = React.useState("");
    const [baseRevision, setBaseRevision] = React.useState(null);
    React.useEffect(() => { if (ready && baseRevision === null) setBaseRevision(record?.revision || 0); }, [ready, baseRevision, record]);
    const current = identity(kind, id, hostId, entity.title, record);
    async function onSave(...args) {
      const result = await props.onSave?.(...args);
      if (result === false) return result;
      if (Object.keys(patch).length) {
        try {
          await hydration;
          if (baseRevision === null) throw new Error("Appearance is not ready");
          const updated = await api()?.update?.({ kind, id, hostId, patch, expectedRevision: baseRevision });
          if (!updated || Object.entries(patch).some(([field, value]) => JSON.stringify(updated[field]) !== JSON.stringify(field === "color" ? value.toUpperCase() : value))) {
            throw new Error("Appearance changed elsewhere");
          }
          if (updated) put(key(kind, id, hostId), updated);
        } catch (cause) { setError(cause?.message || "Could not save appearance"); throw cause; }
      }
      return result;
    }
    const context = { kind, id, hostId, current, patch, setPatch, error, setError, ready: ready && baseRevision !== null };
    const { czKind, czId, czHostId, ...nativeProps } = props;
    return React.createElement(EditorContext.Provider, { value: context }, React.createElement(NativeComponent, { ...nativeProps, onSave }));
}

export function editorElement(React, { kind, id, hostId = "local", title = "" }) {
  if (!id) return null;
  return React.createElement(EditorComponent, { React, kind, id, hostId, title });
}
function EditorComponent({ React, kind, id, hostId, title }) {
    installStyle();
    const [, EditorContext] = contexts(React);
    const session = React.useContext(EditorContext);
    const entity = { kind, id, hostId, title };
    const record = useIdentity(React, entity, false);
    const current = session?.current || identity(kind, id, hostId, title, record);
    const patch = session?.patch || {};
    const preview = { ...current, ...patch };
    const set = (field, value) => session?.setPatch(previous => ({ ...previous, [field]: value }));
    const selectedPalette = patch.palette || current.palette;
    const selectedCategory = patch.category || current.category;
    const selectedTone = patch.tone ?? current.tone;
    const color = patch.color || current.color || palette(selectedPalette).light;
    async function upload(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        if (file.name.toLowerCase().endsWith(".svg") || file.type === "image/svg+xml") {
          if (file.size > 8192) throw new TypeError("SVG is too large");
          const drawing = parseSvgDrawing(await file.text());
          session?.setPatch(previous => ({ ...previous, drawing, image: null, iconMode: "custom" }));
        } else {
          if (file.size > 192 * 1024) throw new TypeError("Image is too large");
          const image = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          const mime = file.name.toLowerCase().endsWith(".png") ? "image/png"
            : file.name.toLowerCase().endsWith(".webp") ? "image/webp"
            : file.name.toLowerCase().endsWith(".ico") ? "image/x-icon" : file.type;
          const normalized = image.replace(/^data:[^;]+;/, `data:${mime};`);
          session?.setPatch(previous => ({ ...previous, image: validateImage(normalized), drawing: null, iconMode: "asset" }));
        }
        session?.setError("");
      } catch (cause) { session?.setError(cause.message || "Invalid SVG"); }
      event.target.value = "";
    }
    const choice = (value, active, onClick, label, content) => React.createElement("button", { key: value, type: "button", disabled: !session?.ready, className: "czsi-choice", "aria-label": label, "aria-pressed": active, onClick }, content);
    return React.createElement("div", { className: "czsi-editor" },
      React.createElement("div", { className: "czsi-options", "aria-hidden": "true" }, iconFor(React, preview, kind === "project" && !(patch.category || record?.origins?.category === "manual") ? "project" : selectedCategory, id)),
      React.createElement("fieldset", null, React.createElement("legend", null, "Color"), React.createElement("div", { className: "czsi-options" },
        ...PALETTES.map(p => choice(p.id, selectedPalette === p.id, () => session?.setPatch(previous => ({ ...previous, palette: p.id, color: p.light })), p.id, React.createElement("span", { style: { width: 19, height: 19, borderRadius: "50%", background: p.light } }))),
        React.createElement("input", { className: "czsi-color", type: "color", disabled: !session?.ready, "aria-label": "Custom color", value: color, onChange: event => set("color", event.target.value) }))),
      React.createElement("fieldset", { disabled: !session?.ready }, React.createElement("legend", null, "Icon"), React.createElement("div", { className: "czsi-options" },
        ...CATEGORIES.map(category => choice(category, selectedCategory === category && preview.iconMode === "preset", () => session?.setPatch(previous => ({ ...previous, category, iconMode: "preset", drawing: null, image: null })), category, glyph(React, category))),
        React.createElement("label", { className: "czsi-upload" }, "Upload icon", React.createElement("input", { type: "file", disabled: !session?.ready, accept: ".svg,.png,.webp,.ico,image/svg+xml,image/png,image/webp,image/x-icon", onChange: upload })))),
      kind === "project" && React.createElement("label", { className: "czsi-check" }, React.createElement("input", { type: "checkbox", disabled: !session?.ready, checked: patch.customThreadIcons ?? current.customThreadIcons ?? false, onChange: event => set("customThreadIcons", event.target.checked) }), "Custom task icons"),
      kind === "thread" && React.createElement("fieldset", null, React.createElement("legend", null, "Tone"), React.createElement("div", { className: "czsi-options" },
        ...[0, 1, 2, 3].map(tone => choice(tone, selectedTone === tone, () => set("tone", tone), `Tone ${tone + 1}`, React.createElement("span", { style: { width: 18, height: 18, borderRadius: "50%", background: palette(selectedPalette).light, opacity: .5 + tone * .15 } }))))),
      session?.error && React.createElement("div", { className: "czsi-error", role: "alert" }, session.error));
}
