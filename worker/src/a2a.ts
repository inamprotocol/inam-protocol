import type { Context, Hono } from "hono";
import type { AppEnv } from "./types.js";

/**
 * Hosted, read-only A2A endpoint (`POST /a2a`, JSON-RPC binding).
 *
 * Lets an A2A agent ask the registry the same questions the hosted MCP
 * endpoint answers (mcp.ts): an agent's reputation, a receipt, or agents by
 * capability. Like mcp.ts it calls the registry's own public GET routes
 * in-process and forwards the caller's IP so per-IP read limits still apply.
 * There are no write skills: writes are signed with the caller's own key and
 * go to the REST API directly.
 *
 * Every request is answered synchronously with a Message (no Task state, no
 * streaming, no push), which A2A allows for SendMessage. Speaks v1.0
 * (`SendMessage`, `A2A-Version: 1.0`) and, for older SDKs, v0.3
 * (`message/send`, `kind` discriminators).
 */

const BASE = "https://api.inamprotocol.org";
const DID_KEY = /did:key:z[1-9A-HJ-NP-Za-km-z]+/;
const RECEIPT_ID = /sha256:[0-9a-f]{64}/;
const CHECK_TARGET = /https?:\/\/[^\s"'<>]+|\b0x[0-9a-fA-F]{40}\b/;

export const agentCard = {
  name: "INAM Protocol Registry",
  description:
    "Evidence-based reputation for AI agents. Ask for an agent's reputation (by did:key) before you trust or pay it, fetch a two-party signed execution receipt, or find agents by capability. Read-only; free; no auth.",
  version: "1.0.0",
  supportedInterfaces: [{ url: `${BASE}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  // v0.3 clients read these two instead of supportedInterfaces.
  url: `${BASE}/a2a`,
  preferredTransport: "JSONRPC",
  protocolVersion: "0.3.0",
  provider: { organization: "INAM Protocol", url: "https://inamprotocol.org" },
  iconUrl: "https://inamprotocol.org/logo-512.png",
  documentationUrl: "https://docs.inamprotocol.org/",
  capabilities: { streaming: false, pushNotifications: false },
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["application/json", "text/plain"],
  skills: [
    {
      id: "check_reputation",
      name: "Check agent reputation",
      description:
        "Reputation of an agent by its did:key: trust score, evidenceLevel (none / countersigned / independently_verified), finalized receipts, dispute and rejection flags. Check evidenceLevel, not trustScore alone.",
      tags: ["reputation", "trust", "agents", "due-diligence"],
      examples: ["What is the reputation of did:key:z6Mk...?", '{"agentId": "did:key:z6Mk..."}'],
    },
    {
      id: "get_receipt",
      name: "Get execution receipt",
      description: "A two-party signed execution receipt by its sha256 id, with any independent verification records.",
      tags: ["receipt", "verification", "audit"],
      examples: ["Show receipt sha256:<64 hex>", '{"receiptId": "sha256:<64 hex>"}'],
    },
    {
      id: "verify_receipt",
      name: "Verify execution receipt",
      description:
        "Registry-side integrity checks on a receipt: both signatures, content-addressed id, transparency-log inclusion, parties not revoked, no open dispute, and spec/output text against the receipt's hashes when supplied. Returns a pass/fail verdict with per-check reasons, signed by the registry's hosted agent key. The work is not re-executed and nothing is recorded.",
      tags: ["receipt", "verification", "audit"],
      examples: ["Verify receipt sha256:<64 hex>", '{"receiptId": "sha256:<64 hex>", "verify": true, "spec": "...", "output": "..."}'],
    },
    {
      id: "search_agents",
      name: "Find agents by capability",
      description: "Registered agents offering a capability, optionally above a minimum trust score.",
      tags: ["discovery", "search", "agents"],
      examples: ["code-review", '{"capability": "translation.tr-en", "minReputation": 10}'],
    },
    {
      id: "check",
      name: "Pre-payment check",
      description:
        "Checks an x402 endpoint URL, an EVM wallet or a did:key before paying it, from public signals (402 payment requirements, ERC-8004 identity and feedback, INAM wallet link and reputation, Web Bot Auth key directory, HTTPS, domain age). Returns verdict (pass / caution / fail, the worst line), per-line checks, and a next step.",
      tags: ["x402", "payments", "due-diligence", "erc-8004"],
      examples: ["Check https://seller.example/api before I pay", '{"target": "0x1111111111111111111111111111111111111111", "method": "GET"}'],
    },
  ],
};

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { message?: A2AMessage } };
type A2APart = { kind?: string; text?: string; data?: Record<string, unknown> };
type A2AMessage = { messageId?: string; contextId?: string; parts?: A2APart[] };

// Text-or-data in, one registry lookup out. Exported for tests.
export function route(message: A2AMessage): { skill: string; arg: Record<string, unknown> } | null {
  const parts = message.parts ?? [];
  const data = parts.find((p) => p.data && typeof p.data === "object")?.data ?? {};
  const text = parts.map((p) => p.text ?? "").join(" ");
  if (typeof data.target === "string") return { skill: "check", arg: { target: data.target, method: data.method } };
  if (typeof data.agentId === "string") return { skill: "check_reputation", arg: { agentId: data.agentId } };
  if (typeof data.receiptId === "string" && (data.verify === true || typeof data.spec === "string" || typeof data.output === "string"))
    return { skill: "verify_receipt", arg: { receiptId: data.receiptId, spec: data.spec, output: data.output } };
  if (typeof data.receiptId === "string") return { skill: "get_receipt", arg: { receiptId: data.receiptId } };
  if (typeof data.capability === "string" || typeof data.minReputation === "number")
    return { skill: "search_agents", arg: { capability: data.capability, minReputation: data.minReputation } };
  const did = text.match(DID_KEY)?.[0];
  if (did) return { skill: "check_reputation", arg: { agentId: did } };
  const receipt = text.match(RECEIPT_ID)?.[0];
  if (receipt && /\bverif/i.test(text)) return { skill: "verify_receipt", arg: { receiptId: receipt } };
  if (receipt) return { skill: "get_receipt", arg: { receiptId: receipt } };
  const target = text.match(CHECK_TARGET)?.[0];
  if (target) return { skill: "check", arg: { target } };
  // A single token like "code-review" is a capability; free-form prose is not guessed at.
  const word = text.trim();
  if (word && !/\s/.test(word)) return { skill: "search_agents", arg: { capability: word } };
  return null;
}

const HELP =
  'Send a did:key to check an agent\'s reputation, a "sha256:<64 hex>" receipt id to fetch a receipt ("verify sha256:..." to check it), an x402 URL or 0x wallet to check it before paying, or a single capability word (e.g. "code-review") to find agents. Structured: {"agentId"}, {"receiptId"}, {"target", "method"} or {"capability", "minReputation"} in a data part.';

export function a2aHandler(app: Hono<AppEnv>) {
  return async (c: Context<AppEnv>) => {
    let req: Rpc;
    try {
      req = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const id = req.id ?? null;
    const v03 = req.method === "message/send";
    if (req.method !== "SendMessage" && !v03)
      return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}. This agent supports SendMessage only.` } });
    const message = req.params?.message;
    if (!message || !Array.isArray(message.parts))
      return c.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: params.message.parts is required" } });

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const get = async (path: string, post?: unknown) => {
      const init = post === undefined ? {} : { method: "POST", body: JSON.stringify(post) };
      const res = await app.request(path, { ...init, headers: { "cf-connecting-ip": ip, "content-type": "application/json" } }, c.env, c.executionCtx);
      return { ok: res.ok, status: res.status, body: await res.json() };
    };

    const r = route(message);
    let parts: A2APart[];
    if (!r) {
      parts = [{ text: HELP }];
    } else {
      let result;
      if (r.skill === "check_reputation") result = await get(`/v1/agents/${encodeURIComponent(r.arg.agentId as string)}/reputation`);
      else if (r.skill === "get_receipt") {
        const rid = encodeURIComponent(r.arg.receiptId as string);
        result = await get(`/v1/receipts/${rid}`);
        if (result.ok) {
          const v = await get(`/v1/receipts/${rid}/verifications`);
          if (v.ok) result.body = { receipt: result.body, ...(v.body as object) };
        }
      } else if (r.skill === "verify_receipt") {
        result = await get(`/v1/receipts/${encodeURIComponent(r.arg.receiptId as string)}/verify`, { spec: r.arg.spec, output: r.arg.output });
      } else if (r.skill === "check") {
        const q = new URLSearchParams({ target: String(r.arg.target) });
        if (typeof r.arg.method === "string") q.set("method", r.arg.method);
        result = await get(`/v1/check?${q}`);
      } else {
        const q = new URLSearchParams();
        if (r.arg.capability) q.set("capability", String(r.arg.capability));
        if (r.arg.minReputation !== undefined) q.set("min_reputation", String(r.arg.minReputation));
        result = await get(`/v1/agents/search?${q}`);
      }
      parts = result.ok
        ? [{ data: { skill: r.skill, result: result.body } }]
        : [{ text: `INAM ${r.skill} failed (HTTP ${result.status}).` }, { data: { skill: r.skill, error: result.body } }];
    }

    const reply = {
      messageId: crypto.randomUUID(),
      ...(message.contextId ? { contextId: message.contextId } : {}),
      role: v03 ? "agent" : "ROLE_AGENT",
      parts: v03 ? parts.map((p) => (p.data ? { kind: "data", data: p.data } : { kind: "text", text: p.text })) : parts,
      ...(v03 ? { kind: "message" } : {}),
    };
    return c.json({ jsonrpc: "2.0", id, result: v03 ? reply : { message: reply } });
  };
}
