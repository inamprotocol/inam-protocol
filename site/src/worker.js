// Only "/" and the agent card run through here (run_worker_first); everything else is plain static assets.
// ponytail: markdown negotiation covers the homepage only (served from llms.txt); add per-page .md when agents need them.
const LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '<https://docs.inamprotocol.org/api/openapi.yaml>; rel="service-desc"; type="application/yaml"',
  '<https://docs.inamprotocol.org/api/>; rel="service-doc"; type="text/html"',
  '</llms.txt>; rel="describedby"; type="text/markdown"',
  '</.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"',
  '</auth.md>; rel="describedby"; type="text/markdown"',
  '</.well-known/ai-catalog.json>; rel="ai-catalog"',
].join(", ");

export default {
  async fetch(request, env) {
    // One agent card, served by the registry that actually speaks A2A.
    if (new URL(request.url).pathname === "/.well-known/agent-card.json") {
      const res = await fetch("https://api.inamprotocol.org/.well-known/agent-card.json");
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" } });
    }
    const wantsMarkdown = /\btext\/markdown\b/i.test(request.headers.get("Accept") || "");
    const asset = await env.ASSETS.fetch(wantsMarkdown ? new Request(new URL("/llms.txt", request.url), request) : request);
    let res;
    if (wantsMarkdown && asset.ok) {
      const text = await asset.text();
      res = new Response(text, asset);
      res.headers.set("Content-Type", "text/markdown; charset=utf-8");
      res.headers.set("x-markdown-tokens", String(Math.ceil(text.length / 4)));
    } else {
      res = new Response(asset.body, asset);
    }
    res.headers.set("Link", LINKS);
    res.headers.append("Vary", "Accept");
    return res;
  },
};
