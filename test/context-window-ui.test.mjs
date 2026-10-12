import assert from "node:assert/strict";
import test from "node:test";
import { contextTokenCount, contextWindowModel, createSessionIndicator, normalizeContext } from "../assets/native-cache-ui.mjs";

test("context totals retain native accounting without inventing component counts", () => {
  const model = contextWindowModel({ usedTokens: 804300, contextWindow: 1000000, percent: 80.43 });
  assert.equal(model.percent, 80.43);
  assert.deepEqual(model.rows.map(row => [row.label, row.tokens]), [["Context used", 804300], ["Free space", 195700]]);
  assert.equal(contextTokenCount(model.usedTokens), "804.3k");
  assert.equal(contextTokenCount(model.contextWindow), "1M");
  assert.equal(contextTokenCount(0), "0");
  assert.equal(contextWindowModel({ percent: 80 }), null);
  assert.equal(contextWindowModel({ usedTokens: null, contextWindow: 1000000 }), null);
  assert.equal(normalizeContext({ percent: null, usedTokens: 500, contextWindow: 1000 }).percent, 50);
});

test("context components and nested rows preserve supplied measurements", () => {
  const breakdown = { messages: 550, systemTools: 20,
    mcpTools: { tokens: 40, children: [{ name: "Search", tokens: 10 }, { name: "Calendar", tokens: 30 }] },
    skills: 5, systemPrompt: 25, mcpServerInstructions: 10,
    memoryFiles: { tokens: 50, children: [{ name: "AGENTS.md", tokens: 50 }] },
    deferredTools: 0, autocompactBuffer: 100 };
  const model = contextWindowModel({ usedTokens: 700, contextWindow: 1000, breakdown });
  assert.deepEqual(model.rows.map(row => row.label), ["Messages", "System tools", "MCP tools", "Skills", "System prompt",
    "MCP server instructions", "Memory files", "Deferred tools", "Autocompact buffer", "Free space"]);
  assert.equal(model.rows.at(-1).tokens, 200);
  assert.equal(model.rows.reduce((sum, row) => sum + row.tokens, 0), 1000);
  assert.deepEqual(model.rows.find(row => row.key === "mcpTools").children, [{ label: "Search", tokens: 10 }, { label: "Calendar", tokens: 30 }]);
  assert.deepEqual(model.rows.find(row => row.key === "memoryFiles").children, [{ label: "AGENTS.md", tokens: 50 }]);
});

test("missing and invalid context categories are not fabricated as zero", () => {
  const model = contextWindowModel({ usedTokens: 700, contextWindow: 1000,
    breakdown: { messages: 500, skills: null, deferredTools: "30", systemPrompt: -1, systemTools: Infinity } });
  assert.deepEqual(model.rows.map(row => [row.label, row.tokens]), [["Messages", 500], ["Context used", 200], ["Free space", 300]]);
  const invalid = contextWindowModel({ usedTokens: 700, contextWindow: 1000, breakdown: { messages: 900 } });
  assert.deepEqual(invalid.rows.map(row => [row.label, row.tokens]), [["Context used", 700], ["Free space", 300]]);
  const badReserve = contextWindowModel({ usedTokens: 700, contextWindow: 1000, breakdown: { autocompactBuffer: 500 } });
  assert.equal(badReserve.rows.at(-1).tokens, 300);
  const invalidChildren = contextWindowModel({ usedTokens: 700, contextWindow: 1000,
    breakdown: { mcpTools: { tokens: 50, children: [{ name: "Search", tokens: 60 }] } } });
  assert.deepEqual(invalidChildren.rows[0].children, []);
});

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useId: () => "session",
  useRef: () => ({ current: null }),
  useState: value => [typeof value === "boolean" ? true : value, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {},
};
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}
function texts(tree) {
  if (typeof tree === "string") return tree;
  if (!tree || typeof tree !== "object") return "";
  return (tree.children ?? []).map(texts).join(" ");
}

test("Session statistics contains collapsed accessible context disclosure and usage bar", () => {
  const render = createSessionIndicator(React);
  const tree = render({ stats: { turns: 4, modelSteps: 20, totalTokens: 9000 }, threadId: "thread",
    contextUsage: { usedTokens: 804300, contextWindow: 1000000 } });
  const all = nodes(tree);
  const disclosure = all.find(node => node.type === "details");
  assert.ok(disclosure);
  assert.equal(disclosure.props.open, undefined);
  assert.match(texts(disclosure), /Context window 804\.3k \/ 1M \(80%\)/);
  assert.match(texts(disclosure), /Context used 804\.3k/);
  assert.match(texts(disclosure), /Free space 195\.7k/);
  const bar = all.find(node => node.props.className === "czss-context-bar");
  assert.equal(bar.props.role, "img");
  assert.equal(bar.props["aria-label"], "Context window 80% used");
  assert.equal(bar.children.length, 2);
  assert.equal(bar.children[0].props.style.width, "80.43%");
  assert.equal(disclosure.children[0].type, "summary");
  assert.ok(nodes(disclosure.children[0]).includes(bar));
});

test("nested context disclosures appear only for supplied MCP and memory breakdowns", () => {
  const tree = createSessionIndicator(React)({ stats: { turns: 1, modelSteps: 1 }, threadId: "thread",
    contextUsage: { usedTokens: 700, contextWindow: 1000,
      breakdown: { mcpTools: { tokens: 30, children: [{ name: "Search", tokens: 30 }] },
        memoryFiles: { tokens: 50, children: [{ name: "AGENTS.md", tokens: 50 }] } } } });
  const groups = nodes(tree).filter(node => node.props.className === "czss-context-group");
  assert.equal(groups.length, 2);
  assert.match(texts(groups[0]), /MCP tools 30\s+Search 30/);
  assert.match(texts(groups[1]), /Memory files 50\s+AGENTS\.md 50/);
});

test("context remains accessible before session statistics are available", () => {
  const render = createSessionIndicator(React);
  const tree = render({ stats: null, threadId: "new", contextUsage: { usedTokens: 250, contextWindow: 1000 } });
  assert.match(texts(tree), /Context 25%/);
  assert.match(texts(tree), /Context window 250 \/ 1k \(25%\)/);
  assert.equal(nodes(tree).filter(node => node.props.className === "czss-values").length, 0);
  assert.equal(render({ stats: null, contextUsage: null }), null);
});
