import { open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { validateImage } from './sidebar-identity-schema.mjs';

const MAX_FILES = 28;
const MAX_BYTES = 384 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024;
const MAX_ENTRIES = 128;
const MAX_CACHED_ROOTS = 128;
const META = [
  ['package.json', 'package'], ['app.json', 'app'], ['app.config.json', 'app'],
  ['manifest.json', 'manifest'], ['public/manifest.json', 'manifest'], ['public/site.webmanifest', 'manifest'],
  ['app/manifest.webmanifest', 'manifest'], ['src/app/manifest.webmanifest', 'manifest'],
  ['android/app/src/main/AndroidManifest.xml', 'android'], ['app/src/main/AndroidManifest.xml', 'android'],
  ['android/app/src/main/res/values/colors.xml', 'androidColors'], ['app/src/main/res/values/colors.xml', 'androidColors'],
  ['src/app/globals.css', 'css'], ['src/index.css', 'css'], ['styles.css', 'css'], ['assets/styles.css', 'css'], ['app/globals.css', 'css'],
];
const FALLBACK = [
  'favicon.ico', 'favicon.png', 'favicon.svg', 'icon.png', 'icon.svg',
  'public/favicon.ico', 'public/favicon.png', 'public/favicon.svg', 'public/icon.png', 'public/icon.svg',
  'app/icon.png', 'app/icon.svg', 'src/app/icon.png', 'src/app/icon.svg',
  'assets/icon.png', 'assets/icon.svg', 'assets/logo.png', 'assets/logo.svg', 'public/logo.png', 'public/logo.svg',
];
const DISCOVER = ['public', 'assets', 'src/assets', 'src/app', 'app'];
const cache = new Map();
const imageExt = /\.(?:png|webp|svg|ico)$/i;
const mimeFor = source => ({ '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' })[path.extname(source).toLowerCase()];
function emptyHints() { return { colors: [], sources: [] }; }
function cloneHints(h) { return { colors: [...h.colors], ...(h.icon ? { icon: { ...h.icon } } : {}), ...(h.image ? { image: h.image } : {}), ...(h.name ? { name: h.name } : {}), sources: [...h.sources] }; }
function rootPath(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0') || /^[a-z][\w+.-]*:\/\//i.test(root)) throw new TypeError('root must be a filesystem path');
  return path.resolve(root);
}
function contained(root, target) { const rel = path.relative(root, target); return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); }
function usableName(value) { return typeof value === 'string' && value.trim().length && value.trim().length <= 80 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null; }
function json(text) { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }
function hex(value, android = false) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('').toLowerCase();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{8}$/i.test(v)) return '#' + (android ? v.slice(3) : v.slice(1, 7)).toLowerCase();
  const rgb = /^rgba?\(\s*(\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:\s*[,/]\s*[\d.]+)?\s*\)$/i.exec(v);
  if (rgb) { const n = rgb.slice(1, 4).map(Number); if (n.every(x => x <= 255)) return '#' + n.map(x => x.toString(16).padStart(2, '0')).join(''); }
  const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%(?:\s*[,/]\s*[\d.]+)?\s*\)$/i.exec(v);
  if (hsl) {
    const [h, s, l] = hsl.slice(1).map(Number); if (h <= 360 && s <= 100 && l <= 100) {
      const a = s / 100 * Math.min(l / 100, 1 - l / 100);
      return '#' + [0, 8, 4].map(n => { const k = (n + h / 30) % 12; return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); }).join('');
    }
  }
  const oklch = /^oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+)?\s*\)$/i.exec(v);
  if (oklch) {
    let [l, chroma, hue] = oklch.slice(1).map(Number);
    if (l > 1) l /= 100;
    if (l >= 0 && l <= 1 && chroma >= 0 && chroma <= 0.5 && hue >= 0 && hue <= 360) {
      const angle = hue * Math.PI / 180, a = chroma * Math.cos(angle), b = chroma * Math.sin(angle);
      const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
      const linear = [4.0767416621*l3 - 3.3077115913*m3 + 0.2309699292*s3,
        -1.2684380046*l3 + 2.6097574011*m3 - 0.3413193965*s3,
        -0.0041960863*l3 - 0.7034186147*m3 + 1.707614701*s3];
      return '#' + linear.map(v => { const x = Math.max(0, Math.min(1, v)); const srgb = x <= 0.0031308 ? 12.92*x : 1.055*x**(1/2.4) - 0.055; return Math.round(srgb*255).toString(16).padStart(2,'0'); }).join('');
    }
  }
  return null;
}
function colorsFromCss(css) {
  const found = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/--(?:primary|brand|accent|color-primary|color-brand)\s*:\s*(#[\da-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\))/gi)) { const c = hex(match[1]); if (c) found.push(c); }
  return found;
}
function colorsFromSvg(svg, android = false) {
  const found = [];
  for (const match of svg.replace(/<!--[\s\S]*?-->/g, '').matchAll(/(?:fill|stroke|fillColor|color)\s*(?:=|:)\s*['"]?(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\))/gi)) {
    if (/^#[0-9a-f]{8}$/i.test(match[1]) && parseInt(android ? match[1].slice(1,3) : match[1].slice(7,9), 16) < 64) continue;
    const c = hex(match[1], android); if (c) found.push(c);
  }
  return found;
}
function pngColor(data) {
  if (data.length < 33 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20), bitDepth = data[24], type = data[25];
  if (!width || !height || width > 1024 || height > 1024 || bitDepth !== 8 || ![2, 6].includes(type)) return null;
  const channels = type === 6 ? 4 : 3, stride = width * channels;
  if ((stride + 1) * height > 4 * 1024 * 1024) return null;
  const chunks = []; let at = 8, compressed = 0;
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at), end = at + 12 + length;
    if (end > data.length) return null;
    const tag = data.toString('ascii', at + 4, at + 8);
    if (tag === 'IDAT') { compressed += length; if (compressed > MAX_IMAGE_BYTES) return null; chunks.push(data.subarray(at + 8, at + 8 + length)); }
    if (tag === 'IEND') break;
    at = end;
  }
  if (!chunks.length) return null;
  let raw; try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height }); } catch { return null; }
  if (raw.length !== (stride + 1) * height) return null;
  const previous = Buffer.alloc(stride), row = Buffer.alloc(stride), histogram = new Map();
  let offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[offset++]; if (filter > 4) return null;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0, up = previous[x], upperLeft = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left; else if (filter === 2) predictor = up; else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) { const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft); predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft; }
      row[x] = (raw[offset++] + predictor) & 255;
    }
    if (y % Math.max(1, Math.floor(height / 64)) === 0) for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 64))) {
      const i = x * channels; if (channels === 4 && row[i + 3] < 128) continue;
      const r = row[i], g = row[i + 1], b = row[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) < 20) continue;
      const key = [r, g, b].map(v => Math.round(v / 16) * 16).join(',');
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
    row.copy(previous);
  }
  const best = [...histogram].sort((a,b) => b[1] - a[1])[0]?.[0];
  if (!best) return null;
  return '#' + best.split(',').map(v => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('');
}
function icoColor(data) {
  if (data.length < 22 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return null;
  const count = Math.min(data.readUInt16LE(4), 16);
  for (let i = count - 1; i >= 0; i--) {
    const at = 6 + i * 16;
    if (at + 16 > data.length) continue;
    const length = data.readUInt32LE(at + 8), offset = data.readUInt32LE(at + 12);
    if (offset + length <= data.length) { const color = pngColor(data.subarray(offset, offset + length)); if (color) return color; }
  }
  return null;
}
function vectorSvg(xml, background = null) {
  if (Buffer.byteLength(xml, 'utf8') > 16 * 1024 || /<!|<\?|\bon[a-z]+\s*=|(?:https?|file|data|javascript):/i.test(xml.replace(/xmlns:android\s*=\s*["']http:\/\/schemas\.android\.com\/apk\/res\/android["']/g, ''))) return null;
  const vector = xml.match(/<vector\b([^>]*)>/)?.[1];
  const attribute = (attrs, name) => attrs.match(new RegExp(`\\bandroid:${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
  const width = Number(attribute(vector ?? '', 'viewportWidth')), height = Number(attribute(vector ?? '', 'viewportHeight'));
  if (!width || !height || width > 4096 || height > 4096 || !Number.isFinite(width * height) || width * height > 16 * 1024 * 1024) return null;
  const output = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`];
  if (background && /^#[0-9a-f]{6}$/i.test(background)) output.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  let depth = 0, paths = 0;
  for (const token of xml.match(/<\/?(?:group|path)\b[^>]*>/g) ?? []) {
    if (/^<\/group/.test(token)) { if (!depth) return null; output.push('</g>'); depth--; continue; }
    if (/^<group/.test(token)) {
      const px = Number(attribute(token, 'pivotX') ?? 0), py = Number(attribute(token, 'pivotY') ?? 0), sx = Number(attribute(token, 'scaleX') ?? 1), sy = Number(attribute(token, 'scaleY') ?? 1);
      if (![px,py,sx,sy].every(Number.isFinite) || ++depth > 8) return null;
      output.push(`<g transform="translate(${px} ${py}) scale(${sx} ${sy}) translate(${-px} ${-py})">`);
      continue;
    }
    if (++paths > 128) return null;
    const d = attribute(token, 'pathData');
    if (!d || d.length > 8192 || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/.test(d)) return null;
    const attrs = [`d="${d}"`];
    for (const [native, svg] of [['fillColor','fill'],['strokeColor','stroke']]) {
      const raw = attribute(token, native);
      if (raw && /^#[0-9a-f]{8}$/i.test(raw)) { attrs.push(`${svg}="#${raw.slice(3)}"`, `${svg}-opacity="${(parseInt(raw.slice(1,3),16)/255).toFixed(3)}"`); }
      else if (raw && /^#[0-9a-f]{3,6}$/i.test(raw)) attrs.push(`${svg}="${raw}"`);
    }
    for (const [native, svg] of [['strokeWidth','stroke-width'],['strokeLineCap','stroke-linecap'],['strokeLineJoin','stroke-linejoin']]) {
      const raw = attribute(token, native);
      if (raw && (/^(?:\d+(?:\.\d+)?)$/.test(raw) || ['round','square','butt','miter','bevel'].includes(raw))) attrs.push(`${svg}="${raw}"`);
    }
    output.push(`<path ${attrs.join(' ')}/>`);
  }
  if (depth || !paths) return null;
  output.push('</svg>');
  return output.join('');
}
function safeRef(ref) {
  if (typeof ref !== 'string' || ref.length > 256 || /[\u0000-\u001f?#]/.test(ref) || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(ref)) return null;
  let decoded; try { decoded = decodeURIComponent(ref); } catch { return null; }
  if (decoded.includes('\\') || !imageExt.test(decoded)) return null;
  return decoded;
}
function relativeRef(base, ref) {
  const safe = safeRef(ref); if (!safe) return null;
  const source = safe.startsWith('/') ? path.posix.join(base.startsWith('public/') || base === 'manifest.json' ? 'public' : '', safe.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(base), safe));
  if (!source || source === '..' || source.startsWith('../') || source.split('/').includes('node_modules') || source.split('/').includes('.git')) return null;
  return source;
}
async function readBounded(root, source, budget, limit = 64 * 1024) {
  if (budget.files >= MAX_FILES || budget.bytes <= 0) return null;
  const target = path.resolve(root, ...source.split('/'));
  if (!contained(root, target)) return null;
  let resolved; try { resolved = await realpath(target); } catch (e) { if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(e?.code)) return null; throw e; }
  if (!contained(root, resolved)) return null;
  let handle; try {
    handle = await open(resolved, 'r'); const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > Math.min(limit, budget.bytes)) return null;
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    budget.files++; budget.bytes -= offset; return data.subarray(0, offset);
  } catch (e) { if (e?.code === 'ENOENT') return null; throw e; } finally { await handle?.close(); }
}
async function discovery(root, budget) {
  const found = []; let entries = 0;
  for (const dir of DISCOVER) {
    if (entries >= MAX_ENTRIES) break;
    const absolute = path.resolve(root, ...dir.split('/'));
    let resolved; try { resolved = await realpath(absolute); } catch { continue; }
    if (!contained(root, resolved)) continue;
    let handle; try { handle = await opendir(resolved); } catch { continue; }
    try {
      for await (const item of handle) {
        if (++entries > MAX_ENTRIES) break;
        if (!item.isFile() || !imageExt.test(item.name) || !/(?:logo|icon|brand|mark|favicon)/i.test(item.name)) continue;
        found.push(`${dir}/${item.name}`);
      }
    } finally { try { await handle.close(); } catch (error) { if (error?.code !== 'ERR_DIR_CLOSED') throw error; } }
  }
  const rank = value => /(?:app|logo)/i.test(value) ? 0 : 1;
  return found.sort((a,b) => rank(a) - rank(b) || a.localeCompare(b));
}
async function scanRoot(root) {
  const result = emptyHints(), colors = new Set(), sources = new Set(), refs = [];
  const budget = { files: 0, bytes: MAX_BYTES };
  const add = (color, source, android = false) => { const c = hex(color, android); if (c) { colors.add(c); sources.add(source); } };
  const ref = (source, value) => { const p = relativeRef(source, value); if (p) refs.push(p); };
  let androidIcon = null, androidVector = null, androidVectorSource = null, androidBackground = null;
  const androidColorResources = new Map();
  for (const [source, kind] of META) {
    const data = await readBounded(root, source, budget);
    if (!data) continue;
    const text = data.toString('utf8');
    if (kind === 'package' || kind === 'app' || kind === 'manifest') {
      const v = json(text); if (!v) continue;
      const name = usableName(kind === 'app' ? v.expo?.name ?? v.name : v.name ?? v.short_name);
      if (name && !result.name) { result.name = name; sources.add(source); }
      for (const key of ['theme_color', 'background_color', 'themeColor', 'backgroundColor']) add(v[key] ?? v.expo?.[key], source);
      if (kind === 'package') { for (const p of [v.icon, v.app?.icon, v.build?.icon, v.productIcon]) ref(source, p); }
      if (kind === 'app') { for (const p of [v.expo?.icon, v.expo?.android?.icon, v.expo?.android?.adaptiveIcon?.foregroundImage, v.icon]) ref(source, p); }
      if (kind === 'manifest' && Array.isArray(v.icons)) { for (const icon of v.icons.slice(0, 32)) ref(source, icon?.src); }
    } else if (kind === 'android') {
      const match = text.match(/android:icon\s*=\s*["']@(?:mipmap|drawable)\/([\w.-]+)["']/i);
      if (match) { androidIcon = match[1]; sources.add(source); }
    } else if (kind === 'androidColors') {
      for (const match of text.matchAll(/<color\b[^>]*name\s*=\s*["']([\w.-]+)["'][^>]*>\s*(#[\da-f]{3,8})\s*<\/color>/gi)) {
        const c = hex(match[2], true); if (c) androidColorResources.set(match[1], c);
      }
      for (const match of text.matchAll(/<color\b[^>]*name\s*=\s*["'][^"']*(?:primary|brand|accent)[^"']*["'][^>]*>\s*(#[\da-f]{3,8})\s*<\/color>/gi)) add(match[1], source, true);
    } else { for (const c of colorsFromCss(text)) add(c, source); }
  }
  if (androidIcon) for (const base of ['android/app/src/main/res', 'app/src/main/res']) {
    for (const xml of [`${base}/mipmap-anydpi-v26/${androidIcon}.xml`, `${base}/drawable/${androidIcon}.xml`]) {
      const data = await readBounded(root, xml, budget, 16 * 1024);
      if (!data) continue;
      const text = data.toString('utf8');
      const backgroundName = text.match(/<background\b[^>]*android:drawable\s*=\s*["']@color\/([\w.-]+)["']/i)?.[1];
      if (backgroundName && androidColorResources.has(backgroundName)) androidBackground = androidColorResources.get(backgroundName);
      for (const color of colorsFromSvg(text, true)) add(color, xml);
      if (!androidVector && text.includes('<vector')) { androidVector = text; androidVectorSource = xml; }
      for (const match of text.matchAll(/@drawable\/([\w.-]+)/g)) {
        for (const ext of ['png','webp']) refs.push(`${base}/drawable/${match[1]}.${ext}`);
        const vector = `${base}/drawable/${match[1]}.xml`;
        const vectorData = await readBounded(root, vector, budget, 16 * 1024);
        if (vectorData) {
          const vectorText = vectorData.toString('utf8');
          for (const color of colorsFromSvg(vectorText, true)) add(color, vector);
          if (!androidVector && vectorText.includes('<vector')) { androidVector = vectorText; androidVectorSource = vector; }
        }
      }
    }
    for (const dir of ['mipmap-xxxhdpi','mipmap-xxhdpi','mipmap-xhdpi','mipmap-hdpi','mipmap-mdpi','mipmap','drawable-xxxhdpi','drawable-xxhdpi','drawable-xhdpi','drawable-hdpi','drawable-mdpi','drawable']) {
      for (const ext of ['png','webp','svg']) refs.push(`${base}/${dir}/${androidIcon}.${ext}`);
    }
  }
  const ordered = [...new Set([...refs, ...FALLBACK, ...await discovery(root, budget)])];
  for (const source of ordered) {
    if (budget.files >= MAX_FILES || budget.bytes <= 0) break;
    const mime = mimeFor(source); if (!mime) continue;
    const data = await readBounded(root, source, budget, mime === 'image/svg+xml' ? 8192 : MAX_IMAGE_BYTES); if (!data) continue;
    const encoded = `data:${mime};base64,${data.toString('base64')}`;
    try { validateImage(encoded); } catch { continue; }
    result.image = encoded;
    if (mime === 'image/svg+xml') {
      const svg = data.toString('utf8'); result.icon = { source, svg };
      for (const c of colorsFromSvg(svg)) add(c, source);
    }
    if (colors.size === 0 && (mime === 'image/png' || mime === 'image/x-icon')) {
      const c = mime === 'image/png' ? pngColor(data) : icoColor(data);
      if (c) add(c, source);
    }
    sources.add(source);
    break;
  }
  if (!result.image && androidVector) {
    const svg = vectorSvg(androidVector, androidBackground);
    if (svg) {
      const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      try { validateImage(image); result.image = image; result.icon = { source: androidVectorSource, svg }; sources.add(androidVectorSource); } catch { /* Keep color hints only. */ }
    }
  }
  result.colors = [...colors].slice(0, 6); result.sources = [...sources];
  return result;
}
export async function readBrandHints(root) {
  const absolute = rootPath(root); let canonical;
  try { canonical = await realpath(absolute); } catch (e) { if (e?.code === 'ENOENT') return emptyHints(); throw e; }
  const key = path.normalize(canonical);
  if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return cloneHints(await value); }
  const pending = (async () => {
    const top = await scanRoot(canonical);
    if (top.image) return top;
    for (const subroot of ['companion-app']) {
      const nestedPath = path.resolve(canonical, subroot);
      let nested; try { nested = await realpath(nestedPath); } catch { continue; }
      if (!contained(canonical, nested)) continue;
      const hints = await scanRoot(nested);
      if (hints.image) return { ...hints, sources: hints.sources.map(s => `${subroot}/${s}`), ...(hints.icon ? { icon: { source: `${subroot}/${hints.icon.source}`, svg: hints.icon.svg } } : {}) };
    }
    return top;
  })().catch(e => { if (cache.get(key) === pending) cache.delete(key); throw e; });
  cache.set(key, pending); while (cache.size > MAX_CACHED_ROOTS) cache.delete(cache.keys().next().value);
  return cloneHints(await pending);
}
export async function invalidateBrandHints(root) {
  const absolute = rootPath(root); let key = absolute;
  try { key = path.normalize(await realpath(absolute)); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  cache.delete(key);
}
