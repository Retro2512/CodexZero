export const PALETTES = Object.freeze([
  { id: "slate", light: "#66768C", dark: "#A9BAD0" },
  { id: "blue", light: "#3879BE", dark: "#83BAF1" },
  { id: "cyan", light: "#18859A", dark: "#78CBDC" },
  { id: "teal", light: "#188779", dark: "#78D0BD" },
  { id: "green", light: "#4A8A48", dark: "#A4D699" },
  { id: "lime", light: "#768B35", dark: "#C2D780" },
  { id: "amber", light: "#A77928", dark: "#E6C57D" },
  { id: "orange", light: "#B66A39", dark: "#EEAB7E" },
  { id: "rose", light: "#AE5971", dark: "#E6A2B5" },
  { id: "violet", light: "#8068AD", dark: "#C3AAE8" },
].map(Object.freeze));

export const CATEGORIES = Object.freeze(["fix", "feature", "question", "chat", "research", "design", "refactor", "test"]);

const PALETTE_IDS = new Set(PALETTES.map(p => p.id));
const CATEGORY_IDS = new Set(CATEGORIES);
const SHAPE_KEYS = {
  path: ["type", "d", "fill", "stroke"],
  circle: ["type", "cx", "cy", "r", "fill", "stroke"],
  rect: ["type", "x", "y", "width", "height", "rx", "fill", "stroke"],
  line: ["type", "x1", "y1", "x2", "y2", "fill", "stroke"],
};
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/gy;
const MAX_IMAGE_BASE64 = 192 * 1024;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

function imageDimensions(width, height) {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
    width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION && width * height <= MAX_IMAGE_PIXELS;
}

function safeSvg(svg) {
  if (!/^\s*(?:<\?xml\s+[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(svg) ||
    !/<\/svg\s*>\s*$/i.test(svg)) return false;
  if (/<\s*(?:script|foreignObject|iframe|object|embed|image|video|audio|animate\w*|set)\b|<!\s*(?:DOCTYPE|ENTITY)\b|<!\[CDATA\[|<\?(?!xml\s)/i.test(svg)) return false;
  const withoutNamespace = svg.replace(/\s+xmlns(?::[\w.-]+)?\s*=\s*(["'])https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)\1/gi, '');
  if (/\bon[a-z][\w:.-]*\s*=|@import\b|(?:javascript|data|https?|file):|\b(?:src|poster|style|xml:base)\s*=|<\s*style\b|\\|&#/i.test(withoutNamespace)) return false;
  const assignments = [...svg.matchAll(/\b(?:[\w.-]+:)?href\s*=/gi)];
  const local = [...svg.matchAll(/\b(?:[\w.-]+:)?href\s*=\s*(["'])#[\w.-]+\1/gi)];
  if (assignments.length !== local.length) return false;
  const urls = [...svg.matchAll(/\burl\s*\(/gi)];
  const localUrls = [...svg.matchAll(/\burl\s*\(\s*(["']?)#[\w.-]+\1\s*\)/gi)];
  if (urls.length !== localUrls.length) return false;
  const root = svg.match(/<svg\b([^>]*)>/i)?.[1];
  if (!root) return false;
  const viewBox = root.match(/\bviewBox\s*=\s*(["'])(.*?)\1/i)?.[2];
  if (viewBox) {
    const values = viewBox.trim().split(/[\s,]+/).map(Number);
    if (values.length !== 4 || values.some(v => !Number.isFinite(v)) || !imageDimensions(values[2], values[3])) return false;
  }
  for (const attribute of ['width', 'height']) {
    const raw = root.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
    if (raw && (!/^\d+(?:\.\d+)?(?:px)?$/.test(raw) || Number.parseFloat(raw) > MAX_IMAGE_DIMENSION)) return false;
  }
  if (!viewBox && !/\bwidth\s*=/.test(root)) return false;
  return true;
}

/** Validate a small, self-contained image data URI for rendering in an img element. */
export function validateImage(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_BASE64 + 48) throw new TypeError('Image is invalid');
  const match = /^data:(image\/(?:png|webp|x-icon|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > MAX_IMAGE_BASE64 || match[2].length % 4 !== 0) throw new TypeError('Image is invalid');
  let bytes;
  try {
    const binary = atob(match[2]);
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (btoa(binary) !== match[2]) throw new Error('Noncanonical base64');
  } catch { throw new TypeError('Image is invalid'); }
  const mime = match[1];
  const u16 = (at) => bytes[at] | (bytes[at + 1] << 8);
  const u32be = (at) => (bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
  const u32le = (at) => (bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16) + bytes[at + 3] * 0x1000000) >>> 0;
  let safe = false;
  if (mime === 'image/png') {
    safe = bytes.length >= 33 && bytes.slice(0, 8).every((v, i) => v === [137,80,78,71,13,10,26,10][i]) &&
      u32be(8) === 13 && String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR' &&
      imageDimensions(u32be(16), u32be(20)) && [1,2,3,4,6].includes(bytes[25]);
  } else if (mime === 'image/webp') {
    const tag = String.fromCharCode(...bytes.slice(12, 16));
    if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' && u32le(4) <= bytes.length - 8) {
      let w = 0, h = 0;
      if (tag === 'VP8X') { w = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16); h = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16); }
      else if (tag === 'VP8L' && bytes[20] === 0x2f) { w = 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)); h = 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0xf) << 10)); }
      else if (tag === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { w = u16(26) & 0x3fff; h = u16(28) & 0x3fff; }
      safe = imageDimensions(w, h);
    }
  } else if (mime === 'image/x-icon') {
    if (bytes.length >= 22 && u16(0) === 0 && (u16(2) === 1 || u16(2) === 2)) {
      const count = u16(4);
      safe = count >= 1 && count <= 16 && bytes.length >= 6 + count * 16;
      for (let i = 0; safe && i < count; i++) {
        const at = 6 + i * 16;
        const w = bytes[at] || 256, h = bytes[at + 1] || 256;
        const size = u32le(at + 8), offset = u32le(at + 12);
        safe = imageDimensions(w, h) && size >= 8 && offset >= 6 + count * 16 && offset + size <= bytes.length;
      }
    }
  } else {
    try { safe = safeSvg(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { safe = false; }
  }
  if (!safe) throw new TypeError('Image is invalid');
  return value;
}

function object(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new TypeError(`${label} has an unsupported field`);
  }
}

function coordinate(value, field, min = 0, max = 24) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a finite coordinate`);
  }
  return value;
}

function pathData(d, budget) {
  if (typeof d !== "string" || !d || d.length > 8192) throw new TypeError("Path data is invalid");
  const tokens = [];
  let at = 0;
  while (at < d.length) {
    while (at < d.length && /[\s,]/.test(d[at])) at++;
    if (at === d.length) break;
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(d);
    if (!match) throw new TypeError("Path data has invalid syntax");
    tokens.push(match[0]);
    at = TOKEN.lastIndex;
  }
  if (!tokens.length || tokens[0].toUpperCase() !== "M") throw new TypeError("Path must begin with M");
  const output = [];
  let i = 0;
  let command = null;
  let commands = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      i++;
      if (command.toUpperCase() === "Z") {
        output.push(command);
        if (++commands > 128 || ++budget.count > 128) throw new TypeError("Path has too many commands");
        command = null;
        continue;
      }
    } else if (!command) throw new TypeError("Path command is missing");
    const upper = command.toUpperCase();
    const arity = ARITY[upper];
    if (arity === undefined) throw new TypeError("Path command is invalid");
    if (i + arity > tokens.length || tokens.slice(i, i + arity).some(t => /^[A-Za-z]$/.test(t))) {
      throw new TypeError("Path command has too few coordinates");
    }
    const values = tokens.slice(i, i + arity).map((raw, index) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < -24 || n > 48) throw new TypeError("Path coordinate is out of bounds");
      if (upper === "A" && (index === 0 || index === 1) && n < 0) throw new TypeError("Arc radius is invalid");
      if (upper === "A" && (index === 3 || index === 4) && n !== 0 && n !== 1) throw new TypeError("Arc flag is invalid");
      return Object.is(n, -0) ? "0" : String(n);
    });
    output.push(command, ...values);
    i += arity;
    if (++commands > 128 || ++budget.count > 128) throw new TypeError("Path has too many commands");
    if (upper === "M") command = command === "M" ? "L" : "l";
  }
  return output.join(" ");
}

export function validateDrawing(input) {
  object(input, ["shapes"], "Drawing");
  if (!Array.isArray(input.shapes) || input.shapes.length < 1 || input.shapes.length > 8) {
    throw new TypeError("Drawing must contain 1 to 8 shapes");
  }
  const budget = { count: 0 };
  const shapes = input.shapes.map(shape => {
    if (!shape || typeof shape !== "object") throw new TypeError("Shape is invalid");
    const fields = SHAPE_KEYS[shape.type];
    if (!fields) throw new TypeError("Shape type is invalid");
    object(shape, fields, "Shape");
    const result = { type: shape.type };
    if (shape.type === "path") result.d = pathData(shape.d, budget);
    if (shape.type === "circle") {
      result.cx = coordinate(shape.cx, "cx");
      result.cy = coordinate(shape.cy, "cy");
      result.r = coordinate(shape.r, "r");
      if (result.r <= 0 || result.cx - result.r < 0 || result.cx + result.r > 24 ||
        result.cy - result.r < 0 || result.cy + result.r > 24) throw new TypeError("Circle is out of bounds");
    }
    if (shape.type === "rect") {
      for (const key of ["x", "y", "width", "height"]) result[key] = coordinate(shape[key], key);
      if (result.width <= 0 || result.height <= 0 || result.x + result.width > 24 || result.y + result.height > 24) throw new TypeError("Rect is out of bounds");
      if (shape.rx !== undefined) {
        result.rx = coordinate(shape.rx, "rx");
        if (result.rx > Math.min(result.width, result.height) / 2) throw new TypeError("Rect radius is out of bounds");
      }
    }
    if (shape.type === "line") {
      for (const key of ["x1", "y1", "x2", "y2"]) result[key] = coordinate(shape[key], key);
    }
    if (shape.fill !== undefined) {
      if (shape.fill !== "none" && shape.fill !== "currentColor") throw new TypeError("Shape fill is invalid");
      result.fill = shape.fill;
    }
    result.stroke = shape.stroke === undefined ? "currentColor" : shape.stroke;
    if (result.stroke !== "none" && result.stroke !== "currentColor") throw new TypeError("Shape stroke is invalid");
    return result;
  });
  const normalized = { shapes };
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > 8192) throw new TypeError("Drawing is too large");
  return normalized;
}

export function validateIdentityPatch(input) {
  const allowed = ["color", "palette", "tone", "category", "iconMode", "drawing", "image", "customThreadIcons", "name"];
  object(input, allowed, "Identity patch");
  const result = {};
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (key === "color" && (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value))) throw new TypeError("Color is invalid");
    if (key === "palette" && !PALETTE_IDS.has(value)) throw new TypeError("Palette is invalid");
    if (key === "tone" && (!Number.isInteger(value) || value < 0 || value > 3)) throw new TypeError("Tone is invalid");
    if (key === "category" && !CATEGORY_IDS.has(value)) throw new TypeError("Category is invalid");
    if (key === "iconMode" && value !== "preset" && value !== "custom" && value !== "asset") throw new TypeError("Icon mode is invalid");
    if (key === "customThreadIcons" && typeof value !== "boolean") throw new TypeError("Custom thread icons setting is invalid");
    if (key === "name" && (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))) throw new TypeError("Name is invalid");
    result[key] = key === "image" ? (value === null ? null : validateImage(value)) :
      key === "drawing" ? (value === null ? null : validateDrawing(value)) :
      key === "color" ? value.toUpperCase() : value;
  }
  return result;
}

function hash(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function deterministicIdentity(key, { parent, title } = {}) {
  if (typeof key !== "string" || !key || key.length > 1024) throw new TypeError("Identity key is invalid");
  const source = typeof title === "string" ? title.toLowerCase() : "";
  const rules = [
    ["fix", /\b(fix|bug|crash|error|broken|repair)\b/],
    ["test", /\b(test|spec|coverage|verify)\b/],
    ["refactor", /\b(refactor|cleanup|restructure)\b/],
    ["design", /\b(design|ui|ux|layout|visual)\b/],
    ["research", /\b(research|investigate|explore|analyze|audit)\b/],
    ["question", /\?|\b(question|how|why|what)\b/],
    ["feature", /\b(feature|add|build|implement|create)\b/],
  ];
  const category = rules.find(([, pattern]) => pattern.test(source))?.[0] ?? "chat";
  const seed = typeof parent === "string" ? parent : key;
  let isProject = false;
  try { const parsed = JSON.parse(key); isProject = Array.isArray(parsed) && parsed.length >= 3 && parsed[1] === 'project'; } catch { /* Other identity keys are opaque. */ }
  const palette = parent && typeof parent === "object" && PALETTE_IDS.has(parent.palette)
    ? parent.palette : isProject ? 'slate' : PALETTES[hash(seed) % PALETTES.length].id;
  const tone = parent && typeof parent === "object" && Number.isInteger(parent.tone) && parent.tone >= 0 && parent.tone <= 3
    ? parent.tone : hash(`${seed}:tone`) % 4;
  return { palette, tone, category, iconMode: "preset", drawing: null };
}
