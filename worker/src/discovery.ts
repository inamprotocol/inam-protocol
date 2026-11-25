import type { Context } from "hono";
import type { AppEnv } from "./types.js";
import { CHECK_PRICE_USDC } from "./apiKeys.js";

/**
 * Payment discovery for indexers (x402scan, AgentCash): which routes on this host cost money.
 *
 * GET /openapi.json      OpenAPI with `x-payment-info` on each paid operation. Format: x402scan docs/DISCOVERY.md
 *                        and @agentcash/discovery SPECIFICATION.md (protocols as objects). It lists only the check
 *                        and report routes; the full API description is openapi.yaml (docs.inamprotocol.org/api).
 * GET /.well-known/x402  x402scan's compatibility list of paid resource URLs. 404 where nothing is sold.
 *
 * The live 402 stays the authority: both documents only point at it.
 */
const TARGET = { name: "target", in: "query", required: true, schema: { type: "string" }, description: "x402 endpoint http(s) URL, 0x EVM wallet (40 hex), or did:key" };
const paymentInfo = (amount: string) => ({ price: { mode: "fixed", currency: "USD", amount }, protocols: [{ x402: {} }] });

export function openApiHandler(specVersion: string) {
  return (c: Context<AppEnv>) => {
    const paid = Boolean(c.env.X402_PAY_TO);
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "INAM Protocol: pre-payment check",
        version: `${specVersion}.0`,
        description: "Check who you are about to pay: an x402 endpoint, a wallet or an INAM agent. This document lists the check routes only; the full registry API is at https://docs.inamprotocol.org/api/.",
        "x-guidance": "GET /v1/check is free. GET /v1/x402/check returns the same verdict and lines over x402. Payment never changes a verdict or a score.",
      },
      servers: [{ url: new URL(c.req.url).origin }],
      externalDocs: { url: "https://docs.inamprotocol.org/api/" },
      paths: {
        "/v1/check": {
          get: { operationId: "checkTarget", summary: "Free pre-payment check: pass, caution or fail with one line per signal", parameters: [TARGET], responses: { "200": { description: "Check report" }, "400": { description: "Bad target" } } },
        },
        ...(paid && {
          "/v1/x402/check": {
            get: {
              operationId: "checkTargetPaid",
              summary: "The same check, paid per call over x402 v2 (USDC on Base)",
              parameters: [TARGET],
              "x-payment-info": paymentInfo(CHECK_PRICE_USDC),
              responses: { "200": { description: "Check report" }, "400": { description: "Bad target" }, "402": { description: "Payment Required" } },
            },
          },
          "/v1/x402/report/{id}": {
            get: {
              operationId: "getPaidReputationReport",
              summary: "Reputation report for one INAM agent: evidence level, flags and signed work history",
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "The agent's did:key" }],
              "x-payment-info": paymentInfo("0.01"),
              responses: { "200": { description: "Report" }, "402": { description: "Payment Required" }, "404": { description: "Unknown agent" } },
            },
          },
        }),
      },
    });
  };
}

export function wellKnownX402Handler(c: Context<AppEnv>) {
  if (!c.env.X402_PAY_TO) return c.notFound();
  return c.json({ version: 1, resources: [`${new URL(c.req.url).origin}/v1/x402/check`] });
}
