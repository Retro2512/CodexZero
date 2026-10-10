import test from "node:test";
import assert from "node:assert/strict";
import { glmToolDiscovery } from "../src/provider-tool-discovery.mjs";
import { customThreadParams } from "../src/provider-router.mjs";

const schema = { type: "object", properties: { PRIVATE_SCHEMA_SENTINEL: { type: "string" } }, required: ["PRIVATE_SCHEMA_SENTINEL"] };
const tools = [
  { kind: "function", name: "exec_command", providerName: "exec_command", description: "Run a local command", parameters: schema },
  { kind: "function", name: "mcp__offline__echo", providerName: "mcp__offline__echo", description: "Repeat fixture text", parameters: schema },
  { kind: "function", name: "mcp__offline__weather", providerName: "mcp__offline__weather", description: "Forecast for a city", parameters: schema },
  { kind: "function", namespace: "mcp__documents", name: "read_document", providerName: "mcp__documents__read_document", description: "Read document contents", parameters: schema },
  { kind: "custom", name: "deferred_fixture", providerName: "deferred_fixture", deferred: true, description: "Deferred custom fixture", parameters: schema },
];

test("GLM discovery keeps ordinary tools upfront and defers registered external schemas", () => {
  const original = structuredClone(tools);
  const discovery = glmToolDiscovery(tools, []);
  assert.deepEqual(discovery.tools().map(tool => tool.providerName), ["exec_command", "tool_search"]);
  assert.deepEqual(tools, original, "Discovery must not mutate registered core tools");
  const output = discovery.search({ query: "echo", limit: 1 });
  assert.deepEqual(output, { tools: [{ name: "mcp__offline__echo", description: "Repeat fixture text" }] });
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_SCHEMA_SENTINEL|parameters|properties|required/);
  assert.deepEqual(discovery.tools().map(tool => tool.providerName), ["exec_command", "mcp__offline__echo", "tool_search"]);
  assert.deepEqual(discovery.tools().find(tool => tool.name === "mcp__offline__echo").parameters, schema);
  assert.equal(discovery.tools().find(tool => tool.name === "mcp__offline__echo").deferred, false);
});

test("discovery searches metadata only with bounded deterministic ranking", () => {
  const discovery = glmToolDiscovery(tools, []);
  assert.deepEqual(discovery.search({ query: "PRIVATE_SCHEMA_SENTINEL" }), { tools: [] });
  assert.equal(discovery.search({ query: "Forecast city", limit: 1 }).tools[0].name, "mcp__offline__weather");
  assert.equal(discovery.search({ query: "documents read_document", limit: 1 }).tools[0].name, "mcp__documents__read_document");
  assert.deepEqual(discovery.search({ query: "mcp offline", limit: 1 }), discovery.search({ query: "mcp offline", limit: 1 }));
  assert.ok(discovery.search({ query: "fixture", limit: 1 }).tools.length <= 1);
});

test("prior executed MCP tools and shared discovery state remain available on subsequent requests", () => {
  const state = new Set();
  const first = glmToolDiscovery(tools, [{ type: "function_call", name: "mcp__offline__echo", arguments: "{}" }], state);
  assert.ok(first.tools().some(tool => tool.providerName === "mcp__offline__echo"));
  assert.equal(first.tools().some(tool => tool.providerName === "mcp__offline__weather"), false);
  first.search({ query: "weather", limit: 1 });
  const second = glmToolDiscovery(tools, [], state);
  assert.ok(second.tools().some(tool => tool.providerName === "mcp__offline__echo"));
  assert.ok(second.tools().some(tool => tool.providerName === "mcp__offline__weather"));
  const namespaced = glmToolDiscovery(tools, [{ type: "function_call", namespace: "mcp__documents", name: "read_document", arguments: "{}" }]);
  assert.ok(namespaced.tools().some(tool => tool.providerName === "mcp__documents__read_document"));
  const custom = glmToolDiscovery(tools, [{ type: "custom_tool_call", name: "deferred_fixture", input: "fixture" }]);
  assert.ok(custom.tools().some(tool => tool.providerName === "deferred_fixture"));
});

test("native search and absent external tools bypass discovery; search names cannot collide", () => {
  assert.equal(glmToolDiscovery([...tools, { kind: "search", name: "tool_search", providerName: "tool_search" }], []), null);
  assert.equal(glmToolDiscovery([tools[0]], []), null);
  const collisions = [...tools,
    { kind: "function", name: "tool_search", providerName: "tool_search" },
    { kind: "function", name: "codexzero_tool_search", providerName: "codexzero_tool_search" }];
  const discovered = glmToolDiscovery(collisions, []).tools();
  assert.equal(discovered.at(-1).providerName, "codexzero_codexzero_tool_search");
  assert.equal(new Set(discovered.map(tool => tool.providerName)).size, discovered.length);
});

test("invalid search arguments never load tools or mutate discovery state", () => {
  const state = new Set();
  const discovery = glmToolDiscovery(tools, [], state);
  for (const args of [null, {}, { query: "" }, { query: "   " }, { query: 123 }, { query: "x".repeat(2001) },
    ...[0, -1, 9, 1.5, "1", null, Infinity].map(limit => ({ query: "echo", limit }))]) {
    assert.equal(typeof discovery.search(args).error, "string");
    assert.equal(state.size, 0);
    assert.deepEqual(discovery.tools().map(tool => tool.providerName), ["exec_command", "tool_search"]);
  }
});

test("GLM 320k compaction stays scoped to tasks and respects output headroom", () => {
  const glm = { id: "offline_glm", apiType: "chat", model: "zai/glm-5.3-flash-uncensored", reasoningMode: "glm-template", contextWindow: 1048576, maxOutputTokens: 131072 };
  const params = { config: { model_instructions_file: "USER_OVERRIDE", unrelated: true }, baseInstructions: "RPC_OVERRIDE" };
  const original = structuredClone(params);
  const routed = customThreadParams(params, glm, "http://127.0.0.1/mock", "offline-token");
  assert.deepEqual(params, original);
  assert.equal(routed.config.model_context_window, 1048576);
  assert.equal(routed.config.model_auto_compact_token_limit, 320000);
  assert.equal(routed.config.model_instructions_file, "USER_OVERRIDE");
  assert.equal(routed.baseInstructions, "RPC_OVERRIDE");
  assert.equal(routed.config.model_catalog_json, undefined);
  const smaller = customThreadParams({}, { ...glm, contextWindow: 200000, maxOutputTokens: 100000 }, "http://127.0.0.1/mock", "offline-token");
  assert.equal(smaller.config.model_auto_compact_token_limit, 90000);
  const nonGlm = customThreadParams({}, { ...glm, model: "other-model" }, "http://127.0.0.1/mock", "offline-token");
  assert.equal(nonGlm.config.model_auto_compact_token_limit, Math.floor(1048576 * .95) - 131072);
});
