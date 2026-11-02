import { describe, expect, it } from "vitest";
import { checkUrl, mcpPaywall } from "../sdk-js/src/check.js";

const PAYTO = "0x2222222222222222222222222222222222222222";
const REQUIRED = { x402Version: 2, resource: { url: "mcp://tool/report" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYTO, extra: { name: "USDC" } }] };
const URL_ = "https://mcp.seller.example/mcp";

/** A fake MCP server. `form` picks how a paid tool signals payment. Records every JSON-RPC method and tool call. */
function server(o: { form?: "result" | "text" | "http402" | "none"; markPaid?: boolean; sse?: boolean; getStatus?: number }) {
  const calls: { method: string; params?: any }[] = [];
  const tools = [
    { name: "free_delete", inputSchema: { type: "object", required: [] } }, // unmarked: must never be called
    { name: "report", inputSchema: { type: "object", properties: { symbol: { type: "string" }, depth: { type: "integer" }, mode: { enum: ["fast", "deep"] } }, required: ["symbol", "depth", "mode"] }, ...(o.markPaid === false ? {} : { _meta: { x402: { amount: "20000" } } }) },
  ];
  const reply = (id: number, body: object, headers: Record<string, string> = {}, status = 200) => {
    const text = JSON.stringify({ jsonrpc: "2.0", id, ...body });
    return o.sse
      ? new Response(`event: message\ndata: ${text}\n\n`, { status, headers: { "content-type": "text/event-stream", ...headers } })
      : new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/.well-known/http-message-signatures-directory") || url.startsWith("https://rdap") || !url.startsWith(URL_)) return new Response("not found", { status: 404 });
    if ((init?.method ?? "GET") === "GET") return new Response("method not allowed", { status: o.getStatus ?? 405 });
    const msg = JSON.parse(String(init?.body));
    if (!msg.method) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }), { status: 400 });
    calls.push({ method: msg.method, params: msg.params });
    if (msg.method === "initialize") return reply(msg.id, { result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" }, capabilities: {} } }, { "mcp-session-id": "s-1" });
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (msg.method === "tools/list") return reply(msg.id, { result: { tools } });
    if (msg.method === "tools/call") {
      if (msg.params.name !== "report") return reply(msg.id, { result: { content: [{ type: "text", text: "deleted everything" }] } });
      if (o.form === "http402") return new Response(JSON.stringify(REQUIRED), { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(REQUIRED)).toString("base64") } });
      if (o.form === "text") return reply(msg.id, { result: { isError: true, content: [{ type: "text", text: JSON.stringify(REQUIRED) }] } });
      if (o.form === "none") return reply(msg.id, { result: { content: [{ type: "text", text: "ran for free" }] } });
      return reply(msg.id, { result: { isError: true, structuredContent: REQUIRED, content: [{ type: "text", text: JSON.stringify(REQUIRED) }] } });
    }
    return reply(msg.id, { error: { code: -32601, message: "not found" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("mcpPaywall", () => {
  it.each(["result", "text", "http402"] as const)("reads PaymentRequired from a paid tool (%s form), over JSON and SSE", async (form) => {
    for (const sse of [false, true]) {
      const s = server({ form, sse });
      const r: any = await mcpPaywall(URL_, 5000, s.fetchFn);
      expect(r.tool).toBe("report");
      expect(r.required.accepts[0].payTo).toBe(PAYTO);
      expect(r.httpStatus).toBe(form === "http402" ? 402 : 200);
    }
  });

  it("calls only the tool marked paid, with placeholders for its required fields, and never with a payment", async () => {
    const s = server({});
    await mcpPaywall(URL_, 5000, s.fetchFn);
    const toolCalls = s.calls.filter((c) => c.method === "tools/call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].params).toEqual({ name: "report", arguments: { symbol: "x", depth: 0, mode: "fast" } });
    expect(JSON.stringify(toolCalls[0].params)).not.toMatch(/x402\/payment/);
  });

  it("calls no tool at all when none is marked paid", async () => {
    const s = server({ markPaid: false });
    const r: any = await mcpPaywall(URL_, 5000, s.fetchFn);
    expect(r.note).toMatch(/none marked paid/);
    expect(s.calls.map((c) => c.method)).not.toContain("tools/call");
  });

  it("says so when a marked tool answers an unpaid call without requirements", async () => {
    const r: any = await mcpPaywall(URL_, 5000, server({ form: "none" }).fetchFn);
    expect(r.note).toMatch(/returned no payment requirements/);
  });

  it("returns null for a URL that does not speak MCP", async () => {
    const notMcp = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    expect(await mcpPaywall(URL_, 5000, notMcp)).toBeNull();
  });
});

describe("checkUrl on an MCP endpoint", () => {
  const opts = (f: typeof fetch) => ({ fetch: f, noRdap: true, registryUrl: "https://registry.test", linkedWallets: new Map<string, string>() });

  it("GET 405, POST not 402: reads the paywall through MCP and checks its payTo", async () => {
    const r = await checkUrl(URL_, opts(server({}).fetchFn));
    const x = r.checks.find((c) => c.id === "x402.response")!;
    expect(x.status).toBe("pass");
    expect(x.label).toMatch(/Paid MCP tool report/);
    expect(r.payment?.accepts[0].payTo).toBe(PAYTO);
    expect(r.checks.some((c) => c.id === "inam.link")).toBe(true); // the payTo got the wallet checks
  });

  it("an MCP server with no marked tool is warn (unread), never fail", async () => {
    const r = await checkUrl(URL_, opts(server({ markPaid: false }).fetchFn));
    expect(r.checks.find((c) => c.id === "x402.response")).toMatchObject({ status: "warn", label: expect.stringMatching(/none marked paid/) });
  });
});
