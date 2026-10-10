function words(value) {
  return String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function toolKey(tool) {
  return `${tool.namespace ?? ""}\0${tool.name}`;
}

function externalTool(tool) {
  return tool.deferred || tool.name.startsWith("mcp__") || tool.namespace?.startsWith("mcp__");
}

// Discovery only searches metadata for tools already registered in core. It
// does not execute tools, change approval policy, or enable disabled services.
export function glmToolDiscovery(tools, items, state = new Set()) {
  if (tools.some(tool => tool.kind === "search")) return null;
  const candidates = tools.filter(externalTool);
  if (!candidates.length) return null;
  for (const item of items) {
    if (!["function_call", "custom_tool_call"].includes(item.type)) continue;
    const prior = tools.find(tool => tool.name === item.name && tool.namespace === item.namespace);
    if (prior) state.add(toolKey(prior));
  }
  let name = "tool_search";
  while (tools.some(tool => tool.providerName === name)) name = `codexzero_${name}`;
  const sources = [...new Set(candidates.map(tool => (tool.namespace ?? tool.name).split("__").slice(0, 2).join("__")))];
  const searchTool = { kind: "bridge_search", name, providerName: name,
    description: `Find tools by purpose or name before calling them. Searchable sources: ${sources.join(", ")}. Only matching tools are loaded.`,
    parameters: { type: "object", properties: { query: { type: "string", description: "Describe the tools needed." },
      limit: { type: "integer", minimum: 1, maximum: 8 } }, required: ["query"], additionalProperties: false } };
  const documents = candidates.map(tool => {
    const terms = new Map();
    for (const term of words(`${tool.name} ${tool.namespace ?? ""}`)) terms.set(term, (terms.get(term) ?? 0) + 3);
    for (const term of words(tool.description)) terms.set(term, (terms.get(term) ?? 0) + 1);
    return { tool, terms, length: [...terms.values()].reduce((sum, value) => sum + value, 0) || 1 };
  });
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length;
  const frequencies = new Map();
  for (const doc of documents) for (const term of doc.terms.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return {
    tools() {
      return [...tools.filter(tool => !externalTool(tool) || state.has(toolKey(tool))).map(tool => ({ ...tool, deferred: false })), searchTool];
    },
    search(args) {
      if (!args || typeof args.query !== "string" || !args.query.trim() || args.query.length > 2000 ||
        (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 8))) {
        return { error: "Use a nonempty query and a limit from 1 to 8." };
      }
      const query = [...new Set(words(args.query))];
      const ranked = documents.map(doc => {
        let score = 0;
        for (const term of query) {
          const frequency = doc.terms.get(term) ?? 0;
          if (!frequency) continue;
          const matches = frequencies.get(term) ?? 0;
          const idf = Math.log(1 + (documents.length - matches + .5) / (matches + .5));
          score += idf * frequency * 2.2 / (frequency + 1.2 * (.25 + .75 * doc.length / average));
        }
        return { tool: doc.tool, score };
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.tool.providerName.localeCompare(b.tool.providerName))
        .slice(0, args.limit ?? 4);
      for (const { tool } of ranked) state.add(toolKey(tool));
      return { tools: ranked.map(({ tool }) => ({ name: tool.providerName, description: tool.description ?? "" })) };
    },
  };
}
