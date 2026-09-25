#!/usr/bin/env node
import { requestAppearance } from "../src/sidebar-appearance-client.mjs";
import { validateIdentityPatch } from "../src/sidebar-identity-schema.mjs";

const MAX_LINE = 512 * 1024;
const string = (maxLength = 1024) => ({ type: "string", minLength: 1, maxLength });
const number = { type: "number", minimum: 0, maximum: 24 };
const paint = { type: "string", enum: ["none", "currentColor"] };
const shape = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "d"], properties: { type: { const: "path" }, d: string(8192), fill: paint, stroke: paint } },
    { type: "object", additionalProperties: false, required: ["type", "cx", "cy", "r"], properties: { type: { const: "circle" }, cx: number, cy: number, r: number, fill: paint, stroke: paint } },
    { type: "object", additionalProperties: false, required: ["type", "x", "y", "width", "height"], properties: { type: { const: "rect" }, x: number, y: number, width: number, height: number, rx: number, fill: paint, stroke: paint } },
    { type: "object", additionalProperties: false, required: ["type", "x1", "y1", "x2", "y2"], properties: { type: { const: "line" }, x1: number, y1: number, x2: number, y2: number, fill: paint, stroke: paint } },
  ],
};
const drawing = { type: "object", additionalProperties: false, required: ["shapes"], properties: { shapes: { type: "array", minItems: 1, maxItems: 8, items: shape } } };
const patch = {
  type: "object", additionalProperties: false,
  properties: {
    color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
    palette: { type: "string", enum: ["slate", "blue", "cyan", "teal", "green", "lime", "amber", "orange", "rose", "violet"] },
    tone: { type: "integer", minimum: 0, maximum: 3 },
    category: { type: "string", enum: ["fix", "feature", "question", "chat", "research", "design", "refactor", "test"] },
    iconMode: { type: "string", enum: ["preset", "custom", "asset"] },
    drawing: { anyOf: [drawing, { type: "null" }] },
    image: { anyOf: [{type:"string",maxLength:262144},{type:"null"}] },
    customThreadIcons: { type: "boolean" },
  },
};

const TOOLS = [
  {
    name: "appearance_list",
    description: "List project or thread appearance and exact stable IDs. Call this first to inspect existing and parent appearance or brand hints. Prefer existing app branding. Only change the requested target.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      kind: { type: "string", enum: ["project", "thread"] },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
      offset: { type: "integer", minimum: 0, maximum: 1000000 },
    } },
  },
  {
    name: "appearance_update",
    description: "Change one exact project or thread ID after listing it. Use a curated palette or a custom drawing on a bounded 24 by 24 grid. Drawings cannot use external resources. Only change the requested target.",
    inputSchema: { type: "object", additionalProperties: false, required: ["kind", "id", "patch"], properties: {
      kind: { type: "string", enum: ["project", "thread"] },
      id: string(),
      hostId: string(),
      patch,
      expectedRevision: { type: "integer", minimum: 0 },
    } },
  },
  {
    name: "appearance_status",
    description: "Read completion or failure counts for an appearance backfill job. Do not repeatedly poll unchanged jobs.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: string(16) } },
  },
  {
    name: "appearance_backfill",
    description: "Create appearance for the requested project or bulk scope. project accepts an exact name, ID or path; omit it only for an explicitly requested bulk operation. Reuses existing app logo and theme locally before calling the selected model for missing artwork. localOnly guarantees no model requests. replace regenerates automatic identities but still preserves manual choices. Returns a background job ID for appearance_status.",
    inputSchema: { type: "object", additionalProperties: false, required: ["scope"], properties: {
      scope: { type: "string", enum: ["projects", "threads", "all"] },
      project: string(4096),
      hostId: string(512),
      localOnly: {type:"boolean"},
      model: string(256),
      replace: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 5000 },
    } },
  },
];

function object(value, fields, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError("Invalid tool arguments");
  }
}

function boundedString(value, max = 1024) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError("Invalid identifier");
}

function boundedInteger(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError("Invalid number");
}

async function callTool(name, args) {
  if (name === "appearance_status") {
    object(args, ["id"], ["id"]);
    if (!/^[a-f0-9]{16}$/.test(args.id)) throw new TypeError("Invalid job");
    return requestAppearance("status", args);
  }
  if (name === "appearance_list") {
    object(args, ["kind", "limit", "offset"]);
    if (args.kind !== undefined && args.kind !== "project" && args.kind !== "thread") throw new TypeError("Invalid kind");
    if (args.limit !== undefined) boundedInteger(args.limit, 1, 5000);
    if (args.offset !== undefined) boundedInteger(args.offset, 0, 1000000);
    return requestAppearance("list", args);
  }
  if (name === "appearance_update") {
    object(args, ["kind", "id", "hostId", "patch", "expectedRevision"], ["kind", "id", "patch"]);
    if (args.kind !== "project" && args.kind !== "thread") throw new TypeError("Invalid kind");
    boundedString(args.id);
    if (args.hostId !== undefined) boundedString(args.hostId);
    object(args.patch, ["color", "palette", "tone", "category", "iconMode", "drawing", "image", "customThreadIcons"]);
    if (!Object.keys(args.patch).length) throw new TypeError("Appearance patch is empty");
    const normalized = validateIdentityPatch(args.patch);
    if (args.expectedRevision !== undefined) boundedInteger(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER);
    return requestAppearance("update", { ...args, patch: normalized });
  }
  if (name === "appearance_backfill") {
    object(args, ["scope", "project", "hostId", "localOnly", "model", "replace", "limit"], ["scope"]);
    if (!["projects", "threads", "all"].includes(args.scope)) throw new TypeError("Invalid scope");
    if (args.model !== undefined) boundedString(args.model, 256);
    if (args.project !== undefined) boundedString(args.project,4096);
    if (args.hostId !== undefined) boundedString(args.hostId,512);
    if (args.localOnly !== undefined && typeof args.localOnly !== "boolean") throw new TypeError("Invalid local setting");
    if (args.replace !== undefined && typeof args.replace !== "boolean") throw new TypeError("Invalid replacement setting");
    if (args.limit !== undefined) boundedInteger(args.limit, 1, 5000);
    return requestAppearance("backfill", args);
  }
  throw new TypeError("Unknown tool");
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  if (!Object.hasOwn(message, "id")) return;
  const id = message.id;
  if (!(typeof id === "string" || typeof id === "number" || id === null)) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "codexzero-appearance", version: "1.0.0" },
    } });
  } else if (message.method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (message.method === "tools/call") {
    try {
      object(message.params, ["name", "arguments"], ["name"]);
      const result = await callTool(message.params.name, message.params.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Appearance request failed" }] } });
    }
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

let buffer = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, chunk]);
  let index;
  while ((index = buffer.indexOf(10)) !== -1) {
    const line = buffer.subarray(0, index);
    buffer = buffer.subarray(index + 1);
    if (line.length > MAX_LINE) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Request is too large" } });
      process.exitCode = 1;
      break;
    }
    try { await handle(JSON.parse(line.toString("utf8"))); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  }
  if (process.exitCode || buffer.length > MAX_LINE) {
    if (!process.exitCode) send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Request is too large" } });
    process.exitCode = 1;
    break;
  }
}
