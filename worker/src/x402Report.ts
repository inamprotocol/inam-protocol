/**
 * Paid reputation report over x402 v2 (HTTP transport): GET /v1/x402/report/:id.
 *
 * Everything in the report is also readable for free from the other /v1
 * endpoints; the paid route exists so agents that shop in x402 Bazaars find
 * INAM there and get one consolidated answer per call. Off unless
 * X402_PAY_TO is set, so deploying this changes nothing until a payout
 * wallet is configured.
 *
 * Flow: unknown agent -> 404 before any charge. No PAYMENT-SIGNATURE -> 402
 * with PAYMENT-REQUIRED. With one -> facilitator /verify, build the report,
 * facilitator /settle, then 200 with PAYMENT-RESPONSE.
 */
import type { Context } from "hono";
import type { AppEnv } from "./types.js";
import * as agentService from "./agentService.js";
import * as receiptService from "./receiptService.js";
import { computeReputation } from "./reputationService.js";
import { fromBase64, fromHex, sign, toHex } from "../../sdk-js/src/crypto/keys.js";
import { webBotAuthHeaders } from "../../sdk-js/src/webBotAuth.js";

const USDC: Record<string, { asset: string; name: string }> = {
  "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" },
  "eip155:84532": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC" },
};
const PAYAI_FACILITATOR = "https://facilitator.payai.network";
export const CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";

const b64 = (v: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))));
const unb64 = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))));
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** What one paid route sells: price in USDC base units (6 decimals) and its Bazaar listing. */
export interface X402Offer {
  price: string;
  description: string;
  tags: string[];
  bazaar: { info: Record<string, unknown>; schema: Record<string, unknown> };
}

export type Settlement = { success?: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string };

function paymentRequired(c: Context<AppEnv>, offer: X402Offer, error?: string) {
  const network = c.env.X402_NETWORK ?? "eip155:8453";
  const usdc = USDC[network];
  if (!usdc) throw new Error(`X402_NETWORK ${network} has no USDC address configured`);
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: {
      url: c.req.url,
      description: offer.description,
      mimeType: "application/json",
      serviceName: "INAM Protocol",
      tags: offer.tags,
      iconUrl: "https://inamprotocol.org/logo-512.png",
    },
    accepts: [{
      scheme: "exact", network, amount: offer.price, asset: usdc.asset, payTo: c.env.X402_PAY_TO!,
      maxTimeoutSeconds: 60, extra: { name: usdc.name, version: "2" },
    }],
    extensions: { bazaar: offer.bazaar },
  };
}

/** CDP API key JWT (EdDSA; the default CDP key type), one per request, bound to its method/host/path. */
function cdpJwt(keyId: string, secret: string, url: string): string {
  const { host, pathname } = new URL(url);
  const now = Math.floor(Date.now() / 1000);
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const head = `${enc({ alg: "EdDSA", kid: keyId, typ: "JWT", nonce: toHex(crypto.getRandomValues(new Uint8Array(16))) })}.${enc({ sub: keyId, iss: "cdp", nbf: now, iat: now, exp: now + 120, uris: [`POST ${host}${pathname}`] })}`;
  // The CDP Ed25519 secret is base64 of seed (32 bytes) || public key (32 bytes).
  return `${head}.${b64url(sign(new TextEncoder().encode(head), fromBase64(secret).slice(0, 32)))}`;
}

async function facilitator(c: Context<AppEnv>, step: "verify" | "settle", paymentPayload: unknown, paymentRequirements: unknown) {
  const cdp = c.env.CDP_API_KEY_ID && c.env.CDP_API_KEY_SECRET ? { id: c.env.CDP_API_KEY_ID, secret: c.env.CDP_API_KEY_SECRET } : null;
  const base = (c.env.X402_FACILITATOR_URL ?? (cdp ? CDP_FACILITATOR : PAYAI_FACILITATOR)).replace(/\/$/, "");
  const url = `${base}/${step}`;
  // Signed with the Web Bot Auth key the Worker publishes at DIRECTORY_PATH, when set.
  const signed = c.env.WEB_BOT_AUTH_KEY
    ? webBotAuthHeaders(url, fromHex(c.env.WEB_BOT_AUTH_KEY), { signatureAgent: `https://${new URL(c.req.url).host}` })
    : {};
  const auth: Record<string, string> = cdp && new URL(url).host === new URL(CDP_FACILITATOR).host ? { authorization: `Bearer ${cdpJwt(cdp.id, cdp.secret, url)}` } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...signed, ...auth },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return (await res.json().catch(() => ({}))) as { isValid?: boolean; invalidReason?: string } & Settlement;
}

/**
 * x402 v2 gate around one handler. No PAYMENT-SIGNATURE -> 402 with
 * PAYMENT-REQUIRED. With one -> facilitator /verify, serve(), facilitator
 * /settle, then the served response plus PAYMENT-RESPONSE. A non-2xx answer
 * from serve() is returned as is and never settled, so errors are free.
 * `settled` runs after a successful settlement and may decorate the response.
 */
export async function x402Paid(
  c: Context<AppEnv>,
  offer: X402Offer,
  serve: () => Promise<Response>,
  settled?: (res: Response, settlement: Settlement) => Promise<Response>,
): Promise<Response> {
  const header = c.req.header("payment-signature");
  if (!header) return c.json({}, 402, { "PAYMENT-REQUIRED": b64(paymentRequired(c, offer, "PAYMENT-SIGNATURE header is required")) });

  let payload: { accepted?: unknown };
  try {
    payload = unb64(header);
  } catch {
    return c.json({ error: { code: "INVALID_PAYMENT", message: "PAYMENT-SIGNATURE is not base64 JSON" } }, 400);
  }
  const requirements = paymentRequired(c, offer).accepts[0];
  const verified = await facilitator(c, "verify", payload, requirements);
  if (!verified.isValid) {
    return c.json({}, 402, { "PAYMENT-REQUIRED": b64(paymentRequired(c, offer, verified.invalidReason ?? "payment verification failed")) });
  }
  let res = await serve();
  if (!res.ok) return res;
  const settlement = await facilitator(c, "settle", payload, requirements);
  if (!settlement.success) return c.json({}, 402, { "PAYMENT-RESPONSE": b64(settlement) });
  if (settled) res = await settled(res, settlement);
  const headers = new Headers(res.headers);
  headers.set("PAYMENT-RESPONSE", b64(settlement));
  // A paid answer is for this payer only: no shared caches.
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

const REPORT_OFFER: X402Offer = {
  price: "10000", // 0.01 USDC
  description: "INAM reputation report for an AI agent: evidence level, trust score, flags and its signed work history (finished jobs, counterparties, disputes).",
  tags: ["reputation", "trust", "agents", "verification"],
  bazaar: {
    info: {
      input: { type: "http", method: "GET" },
      output: { type: "json", example: { evidenceLevel: "countersigned", trustScore: 3.1, workHistory: { jobsFinalized: 4, distinctCounterparties: 3 } } },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: { type: "object", properties: { type: { const: "http" }, method: { enum: ["GET"] } }, required: ["type", "method"] },
        output: { type: "object", properties: { type: { type: "string" }, example: { type: "object" } }, required: ["type"] },
      },
      required: ["input"],
    },
  },
};

async function buildReport(c: Context<AppEnv>, id: string, agent: Awaited<ReturnType<typeof agentService.getAgent>>) {
  const reputation = await computeReputation(c.env, id);
  const visible = (await receiptService.listByAgent(c.env, id)).filter((r) => receiptService.isReceiptVisible(r, undefined, false));
  const asWorker = visible.filter((r) => r.agentB.id === id);
  const done = asWorker.filter((r) => r.status === "finalized");
  const byCounterparty = new Map<string, number>();
  for (const r of done) byCounterparty.set(r.agentA.id, (byCounterparty.get(r.agentA.id) ?? 0) + 1);
  return {
    agent: { id, capabilities: agent.capabilities, metadata: agent.metadata, linked: agent.linked, revokedAt: agent.revokedAt ?? null, createdAt: agent.createdAt },
    reputation,
    workHistory: {
      jobsFinalized: done.length,
      distinctCounterparties: byCounterparty.size,
      largestCounterpartyShare: done.length ? Math.max(...byCounterparty.values()) / done.length : 0,
      jobsDisputed: asWorker.filter((r) => (r.dispute?.status ?? "none") !== "none").length,
      lastCompletedAt: done.reduce<string | null>((m, r) => (!m || r.result.completedAt > m ? r.result.completedAt : m), null),
      recent: done.slice(-10).reverse().map((r) => ({ receiptId: r.receiptId, capability: r.task.capability, requester: r.agentA.id, completedAt: r.result.completedAt })),
    },
    verify: "Each receipt is signed by both parties; fetch it at /v1/receipts/:id and check it with the inamprotocol SDK.",
    generatedAt: new Date().toISOString(),
  };
}

export async function x402ReportHandler(c: Context<AppEnv>) {
  if (!c.env.X402_PAY_TO) return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  const id = c.req.param("id")!;
  const agent = await agentService.getAgent(c.env, id); // unknown agent: 404, never a charge
  return x402Paid(c, REPORT_OFFER, async () => c.json(await buildReport(c, id, agent)));
}
