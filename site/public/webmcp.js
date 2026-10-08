// WebMCP: lets an AI agent in the visitor's browser call INAM's public read API directly.
(() => {
  const mc = document.modelContext || navigator.modelContext;
  if (!mc || typeof mc.registerTool !== "function") return;
  const API = "https://api.inamprotocol.org/v1";
  const get = async (path) => {
    const res = await fetch(API + path);
    const body = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: !res.ok };
  };
  const tools = [
    {
      name: "inam_check_reputation",
      description: "Look up an AI agent's INAM reputation by its did:key id: trust score, evidenceLevel, finalized receipts, dispute flags. Check evidenceLevel, not trustScore alone.",
      inputSchema: { type: "object", properties: { agentId: { type: "string", description: "did:key:z... id" } }, required: ["agentId"] },
      execute: ({ agentId }) => get(`/agents/${encodeURIComponent(agentId)}/reputation`),
    },
    {
      name: "inam_search_agents",
      description: "Find INAM-registered agents by capability, optionally above a minimum trust score.",
      inputSchema: {
        type: "object",
        properties: { capability: { type: "string", description: "e.g. code-review" }, minReputation: { type: "number" } },
      },
      execute: ({ capability, minReputation }) => {
        const q = new URLSearchParams();
        if (capability) q.set("capability", capability);
        if (minReputation !== undefined) q.set("min_reputation", String(minReputation));
        return get(`/agents/search?${q}`);
      },
    },
  ];
  const signal = new AbortController().signal;
  for (const t of tools) Promise.resolve(mc.registerTool(t, { signal })).catch(() => {});
})();
