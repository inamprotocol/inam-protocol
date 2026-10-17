import type { Context, Hono } from "hono";
import type { AppEnv } from "./types.js";
import { checkTarget, nextStep } from "../../sdk-js/src/check.js";
import { fromHex } from "../../sdk-js/src/crypto/keys.js";
import { webBotAuthHeaders } from "../../sdk-js/src/webBotAuth.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { sign, toBase64 } from "../../sdk-js/src/crypto/keys.js";
import { buildSignableContent } from "../../sdk-js/src/core/receiptContent.js";
import { httpOutputHash, httpSpecHash, INAM_RECEIPT_HEADER, INAM_REQUESTER_HEADER } from "../../sdk-js/src/http.js";
import { x402Paid, type Settlement, type X402Offer } from "./x402Report.js";
import { demoKeypair, ensureRegistered } from "./demo.js";
import * as receiptService from "./receiptService.js";
import { renderBadgeSvg } from "./badgeService.js";
import { CHECK_PRICE_UNITS, CHECK_PRICE_USDC, meterKey, refundKey } from "./apiKeys.js";

/**
 * Hosted pre-payment check: GET /v1/check?target=<url | 0x wallet | did:key>[&method=POST][&rdap=0].
 *
 * Runs the same engine as `npx inamprotocol check --json` (sdk-js/src/check.ts) and adds
 * `next` (one short step for the caller) and `cachedAt`. Results are kept in the Cache API
 * for TTL seconds: the ERC-8004 indexer allows 30 req/min per IP and every caller shares
 * this Worker's egress. Registry lookups run in-process (app.request, caller's IP forwarded);
 * every other outbound request is signed with Web Bot Auth when WEB_BOT_AUTH_KEY is set.
 */
const TTL = 600;
const USAGE = "Expected target=<x402 endpoint http(s) URL | 0x EVM wallet (40 hex) | did:key:z...>; optional method=POST for endpoints that only answer POST, rdap=0 to skip the domain-age lookup.";
const bad = (c: Context<AppEnv>, message: string) => c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);

export function checkHandler(app: Hono<AppEnv>) {
  return async (c: Context<AppEnv>) => {
    const target = c.req.query("target")?.trim();
    const method = (c.req.query("method") ?? "GET").toUpperCase();
    const noRdap = c.req.query("rdap") === "0";
    if (!target) return bad(c, `target is required. ${USAGE}`);
    if (!["GET", "POST", "HEAD"].includes(method)) return bad(c, `method must be GET, POST or HEAD. ${USAGE}`);
    const self = new URL(c.req.url);
    if (target.startsWith(`${self.origin}/v1/check`) || target.startsWith(`${self.origin}/v1/x402/check`)) return bad(c, "target cannot be this check endpoint");

    // Keyed under our own origin: the Cache API only stores keys in the zone the Worker runs on.
    const key = new Request(`${self.origin}/__check-cache?${new URLSearchParams({ target, method, rdap: noRdap ? "0" : "1" })}`);
    const hit = await caches.default.match(key);
    if (hit) return c.json(await hit.json(), 200, { "cache-control": `public, max-age=${TTL}` });

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const signer = c.env.WEB_BOT_AUTH_KEY ? fromHex(c.env.WEB_BOT_AUTH_KEY) : null;
    const f = (async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const headers = init.headers as Record<string, string> | undefined;
      if (url.startsWith(`${self.origin}/v1/agents`))
        return app.request(url.slice(self.origin.length), { ...init, headers: { ...headers, "cf-connecting-ip": ip } }, c.env, c.executionCtx);
      const signed = signer ? webBotAuthHeaders(url, signer, { signatureAgent: `https://${self.host}` }) : {};
      const res = await fetch(url, { ...init, headers: { ...headers, ...signed } });
      // A 429 makes the engine sleep for Retry-After (CLI behaviour, minutes on shared egress IPs).
      // A hosted request can't wait that long, so surface it as a plain failure: that line becomes unknown.
      return res.status === 429 ? new Response(null, { status: 503, statusText: "rate limited upstream" }) : res;
    }) as typeof fetch;

    let report;
    try {
      report = await checkTarget(target, { registryUrl: self.origin, method, noRdap, fetch: f });
    } catch (e) {
      return bad(c, `${(e as Error).message}. ${USAGE}`);
    }
    const body = { ...report, next: nextStep(report), cachedAt: new Date().toISOString() };
    c.executionCtx.waitUntil(caches.default.put(key, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `max-age=${TTL}` } })));
    return c.json(body, 200, { "cache-control": `public, max-age=${TTL}` });
  };
}

/**
 * Paid twin of the check: GET /v1/x402/check, same params, same JSON body, behind
 * x402 v2 (0.001 USDC on Base). It buys the same answer /v1/check gives for free;
 * payment never changes a verdict or a score (GOVERNANCE.md). Off until X402_PAY_TO is set.
 */
const CHECK_PRICE = { units: CHECK_PRICE_UNITS, usdc: CHECK_PRICE_USDC }; // set in apiKeys.ts
const CHECK_OFFER: X402Offer = {
  price: CHECK_PRICE.units,
  description: "Pre-payment check of an x402 endpoint URL, EVM wallet or did:key: INAM ID bound to its payTo wallet, countersigned work history, ERC-8004 registration, domain age. Returns a pass/caution/fail verdict with per-line checks. Same answer as the free GET /v1/check.",
  tags: ["trust", "verification", "x402", "agents", "reputation"],
  bazaar: {
    info: {
      input: { type: "http", method: "GET", queryParams: { target: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" } },
      output: {
        type: "json",
        example: {
          target: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          kind: "wallet",
          verdict: "caution",
          checks: [{ id: "inam.link", status: "warn", label: "No INAM ID has proved control of this wallet" }],
          next: "Ask the payee for an INAM ID linked to this wallet.",
          cachedAt: "2026-10-10T00:00:00.000Z",
        },
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { const: "http" },
            method: { enum: ["GET"] },
            queryParams: {
              type: "object",
              properties: {
                target: { type: "string", description: "x402 endpoint http(s) URL, 0x EVM wallet (40 hex) or did:key" },
                method: { type: "string", enum: ["GET", "POST", "HEAD"], description: "Method the endpoint answers (default GET)" },
                rdap: { type: "string", enum: ["0"], description: "0 skips the domain-age lookup" },
              },
              required: ["target"],
              additionalProperties: true,
            },
          },
          required: ["type", "method"],
        },
        output: {
          type: "object",
          properties: {
            type: { type: "string" },
            example: {
              type: "object",
              properties: {
                target: { type: "string" },
                kind: { enum: ["url", "wallet", "did"] },
                verdict: { enum: ["pass", "caution", "fail"] },
                checks: { type: "array", items: { type: "object", properties: { id: { type: "string" }, status: { enum: ["pass", "warn", "fail", "info"] }, label: { type: "string" } } } },
                next: { type: "string" },
                cachedAt: { type: "string" },
              },
            },
          },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  },
};

// demo.* receipts are real, signed and logged but never count toward reputation
// (SPEC.md §5.2), so a $0.001 call can't buy the payer score.
const RECEIPT_CAPABILITY = "demo.x402-check";

/**
 * SPEC.md §15, worker side: the registry's hosted agent (DEMO_PRIVATE_KEY, the
 * key that also signs hosted receipt checks) drafts a receipt naming the
 * INAM-Requester and returns its id in INAM-Receipt; the requester countersigns
 * it (inamFetch does). Any failure, e.g. an unregistered requester, answers
 * without a receipt.
 */
async function draftReceipt(c: Context<AppEnv>, res: Response, settlement: Settlement): Promise<Response> {
  const requester = c.req.header(INAM_REQUESTER_HEADER)?.trim();
  if (!requester || !c.env.DEMO_PRIVATE_KEY) return res;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const out = new Response(bytes, res);
  try {
    const kp = demoKeypair(c.env);
    const now = new Date().toISOString();
    const input = {
      jobId: `http:${crypto.randomUUID()}`,
      task: { capability: RECEIPT_CAPABILITY, specHash: httpSpecHash("GET", c.req.url, new Uint8Array()), createdAt: now },
      result: { outputHash: httpOutputHash(bytes), completedAt: now },
      ...(settlement.transaction ? { settlement: { paymentRef: settlement.transaction, amount: CHECK_PRICE.usdc, currency: "USDC" } } : {}),
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    await ensureRegistered(c.env, kp);
    const content = buildSignableContent(requester, kp.did, input);
    const signature = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), kp.privateKey));
    const receipt = await receiptService.createDraft(c.env, kp.did, { ...input, agentAId: requester, signature });
    out.headers.set(INAM_RECEIPT_HEADER, receipt.receiptId);
  } catch {
    // ponytail: dropped silently; the paid answer matters more than its receipt. Log it if receipts go missing.
  }
  return out;
}

export function x402CheckHandler(app: Hono<AppEnv>) {
  const free = checkHandler(app);
  return async (c: Context<AppEnv>) => {
    // SPEC.md §16: an API key (INAM-Key header) spends its free tier first; metering only, no billing.
    // An exhausted key falls through to the normal x402 payment below.
    const apiKey = c.req.header("inam-key")?.trim();
    let exhausted = false;
    if (apiKey && c.req.query("target")?.trim()) {
      const metered = await meterKey(c.env, apiKey);
      if (metered === "invalid") return c.json({ error: { code: "INVALID_API_KEY", message: "Unknown or revoked INAM-Key" } }, 401);
      if (metered === "granted") {
        const res = await free(c);
        if (res.status !== 200) await refundKey(c.env, apiKey); // a rejected request is not a call
        return res;
      }
      exhausted = true;
    }
    if (!c.env.X402_PAY_TO) {
      if (exhausted) return c.json({ error: { code: "FREE_TIER_EXHAUSTED", message: "This API key's free tier is used up and this registry has no payment route configured." } }, 402);
      return c.json({ error: { code: "X402_DISABLED", message: "The paid check is not enabled on this registry (no payout wallet configured). GET /v1/check is free and returns the same answer." } }, 503);
    }
    if (!c.req.query("target")?.trim()) return free(c); // 400 with usage, never a charge
    return x402Paid(c, CHECK_OFFER, async () => free(c), (res, s) => draftReceipt(c, res, s));
  };
}

/**
 * GET /v1/badge?target=...: a shields-style SVG of the /v1/check verdict, for a seller's README.
 * Runs the free check handler (same cache, same outbound rules); any non-200 or error is a grey "unknown".
 */
const BADGE_COLORS: Record<string, string> = { pass: "#4c1", caution: "#dfb317", fail: "#e05d44" };
export function badgeHandler(app: Hono<AppEnv>) {
  const check = checkHandler(app);
  return async (c: Context<AppEnv>) => {
    let verdict = "unknown";
    try {
      const res = await check(c);
      const v = res.status === 200 ? ((await res.json()) as { verdict?: string }).verdict : undefined;
      if (v && v in BADGE_COLORS) verdict = v;
    } catch {
      // never leak errors through an image
    }
    return c.body(renderBadgeSvg({ label: "INAM", value: verdict, color: BADGE_COLORS[verdict] ?? "#9f9f9f", status: "scored" }), 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    });
  };
}
