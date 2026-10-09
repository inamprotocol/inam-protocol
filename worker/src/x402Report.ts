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

const USDC: Record<string, { asset: string; name: string }> = {
  "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" },
  "eip155:84532": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC" },
};
const PRICE = "10000"; // 0.01 USDC (6 decimals)

const b64 = (v: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))));
const unb64 = (s: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))));

function paymentRequired(c: Context<AppEnv>, error?: string) {
  const network = c.env.X402_NETWORK ?? "eip155:8453";
  const usdc = USDC[network];
  if (!usdc) throw new Error(`X402_NETWORK ${network} has no USDC address configured`);
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: {
      url: c.req.url,
      description: "INAM reputation report for an AI agent: evidence level, trust score, flags and its signed work history (finished jobs, counterparties, disputes).",
      mimeType: "application/json",
      serviceName: "INAM Protocol",
      tags: ["reputation", "trust", "agents", "verification"],
      iconUrl: "https://inamprotocol.org/logo-512.png",
    },
    accepts: [{
      scheme: "exact", network, amount: PRICE, asset: usdc.asset, payTo: c.env.X402_PAY_TO!,
      maxTimeoutSeconds: 60, extra: { name: usdc.name, version: "2" },
    }],
    extensions: {
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
    },
  };
}

async function facilitator(c: Context<AppEnv>, step: "verify" | "settle", paymentPayload: unknown, paymentRequirements: unknown) {
  const base = (c.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network").replace(/\/$/, "");
  const res = await fetch(`${base}/${step}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return (await res.json().catch(() => ({}))) as { isValid?: boolean; invalidReason?: string; success?: boolean; errorReason?: string };
}

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

  const header = c.req.header("payment-signature");
  if (!header) return c.json({}, 402, { "PAYMENT-REQUIRED": b64(paymentRequired(c, "PAYMENT-SIGNATURE header is required")) });

  let payload: { accepted?: unknown };
  try {
    payload = unb64(header);
  } catch {
    return c.json({ error: { code: "INVALID_PAYMENT", message: "PAYMENT-SIGNATURE is not base64 JSON" } }, 400);
  }
  const requirements = paymentRequired(c).accepts[0];
  const verified = await facilitator(c, "verify", payload, requirements);
  if (!verified.isValid) {
    return c.json({}, 402, { "PAYMENT-REQUIRED": b64(paymentRequired(c, verified.invalidReason ?? "payment verification failed")) });
  }
  const report = await buildReport(c, id, agent);
  const settled = await facilitator(c, "settle", payload, requirements);
  if (!settled.success) return c.json({}, 402, { "PAYMENT-RESPONSE": b64(settled) });
  return c.json(report, 200, { "PAYMENT-RESPONSE": b64(settled) });
}
