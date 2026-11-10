import type { Context, Hono } from "hono";
import { McpServer, WebStandardStreamableHTTPServerTransport, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readTools, READ_ONLY, type RegistryReader } from "../../mcp/src/readTools.js";
import type { AppEnv } from "./types.js";
import mcpPkg from "../../mcp/package.json";
import { countMcpUsage } from "./mcpUsage.js";

/**
 * Hosted, read-only MCP endpoint (`POST /mcp`, stateless).
 *
 * Serves the 2026-07-28 protocol revision and, for 2025-era clients, the
 * stateless legacy fallback (both from @modelcontextprotocol/server v2, one
 * server factory for both). Before v2 a 2026-07-28 client got a 400 on its
 * first request and had to fall back to `initialize`.
 *
 * Exposes the same read tools as the `inam-mcp` stdio package (shared from
 * mcp/src/readTools.ts). Write tools are deliberately absent: they sign with
 * the caller's private key, which must never be sent to a hosted server.
 * Anyone who needs writes runs `npx inam-mcp` locally with their own key.
 *
 * Tools call the registry's own public GET routes in-process (app.request,
 * no network hop), forwarding the caller's IP so the per-IP read rate limit
 * applies to the real client rather than to the Worker itself.
 */
export function mcpHandler(app: Hono<AppEnv>) {
  return async (c: Context<AppEnv>) => {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    // `post` (a JSON body) is only for the side-effect-free POST /receipts/:id/verify.
    const get = async (path: string, post?: unknown) => {
      const init = post === undefined ? {} : { method: "POST", body: JSON.stringify(post) };
      const res = await app.request(path, { ...init, headers: { "cf-connecting-ip": ip, "content-type": "application/json" } }, c.env, c.executionCtx);
      const body = await res.json();
      if (!res.ok) throw new Error(`${post === undefined ? "GET" : "POST"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
      return body;
    };
    const reader: RegistryReader = {
      getReputation: (id) => get(`/v1/agents/${encodeURIComponent(id)}/reputation`),
      searchAgents: ({ capability, minReputation }) => {
        const params = new URLSearchParams();
        if (capability) params.set("capability", capability);
        if (minReputation !== undefined) params.set("min_reputation", String(minReputation));
        return get(`/v1/agents/search?${params}`);
      },
      getReceipt: (id) => get(`/v1/receipts/${encodeURIComponent(id)}`),
      listReceiptVerifications: (id) => get(`/v1/receipts/${encodeURIComponent(id)}/verifications`),
      verifyReceipt: (id, given) => get(`/v1/receipts/${encodeURIComponent(id)}/verify`, given),
      check: ({ target, method }) => get(`/v1/check?${new URLSearchParams({ target, ...(method ? { method } : {}) })}`),
    };

    const makeServer = () => {
      const server = new McpServer({ name: "inam-mcp", version: mcpPkg.version });
      for (const t of readTools(reader)) {
        server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: z.object(t.shape as z.ZodRawShape), annotations: { ...READ_ONLY, ...t.annotations, title: t.title } }, t.handler);
      }
      return server;
    };

    const req = c.req.raw;
    // Aggregate counts only (no IP, no arguments): see mcpUsage.ts.
    if (req.method === "POST") c.executionCtx.waitUntil(countMcpUsage(c.env, req.clone()));

    // 2025-era clients: the same stateless JSON transport as before v2.
    if (await isLegacyRequest(req)) {
      const server = makeServer();
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      return transport.handleRequest(req);
    }
    // 2026-07-28 clients: per-request envelope, plain JSON answers.
    const handler = createMcpHandler(makeServer, { legacy: "reject", responseMode: "json" });
    return handler.fetch(req);
  };
}
