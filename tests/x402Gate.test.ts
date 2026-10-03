import { describe, it, expect } from "vitest";
import { withInamX402Gate, inamX402Extension, X402PaymentBlocked } from "../sdk-js/src/x402.js";
import type { InamClient } from "../sdk-js/src/client.js";

// SPEC.md §11.2: the gate decides before any payment is signed.
const DID = "did:key:z6MkpayeeEXAMPLE";
const BOUND = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function registry(opts: { linked?: string; evidenceLevel?: string; trustScore?: number; revokedAt?: string; missing?: boolean } = {}) {
  const fail = () => Promise.reject(new Error("404"));
  return {
    getAgent: opts.missing ? fail : async () => ({ id: DID, linked: opts.linked === undefined ? { erc8004_id: BOUND } : { erc8004_id: opts.linked }, revokedAt: opts.revokedAt }),
    getReputation: opts.missing ? fail : async () => ({ trustScore: opts.trustScore ?? 40, evidenceLevel: opts.evidenceLevel ?? "countersigned" }),
  } as unknown as InamClient;
}

function server402(payTos: string[], extensions: object | null = inamX402Extension(DID)): typeof fetch {
  const required = { x402Version: 2, resource: { url: "https://paid.example/api" }, accepts: payTos.map((payTo) => ({ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xusdc", payTo, maxTimeoutSeconds: 60 })), extensions };
  return async () => new Response(null, { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
}

const blockedReason = (p: Promise<unknown>) => p.then(() => "allowed", (e) => (e instanceof X402PaymentBlocked ? e.decision.reason : `threw ${e}`));

describe("x402 verify-before-pay gate (SPEC.md §11.2)", () => {
  it("passes non-402 responses through untouched", async () => {
    const ok = new Response("hi", { status: 200 });
    expect(await withInamX402Gate(async () => ok, registry())("https://x")).toBe(ok);
  });

  it("passes a rejected paid retry through so the payment wrapper sees the real error", async () => {
    const rejected = new Response(null, { status: 402 });
    const paid = new Request("https://x", { headers: { "PAYMENT-SIGNATURE": "sig" } });
    expect(await withInamX402Gate(async () => rejected, registry())(paid)).toBe(rejected);
  });

  it("blocks a payee that names no INAM ID", async () => {
    expect(await blockedReason(withInamX402Gate(server402([BOUND], null), registry())("https://x"))).toMatch(/names no INAM ID/);
  });

  it("blocks a payee whose DID is not in the registry", async () => {
    expect(await blockedReason(withInamX402Gate(server402([BOUND]), registry({ missing: true }))("https://x"))).toMatch(/not found/);
  });

  it("blocks when payTo is not the address the DID proved control of (borrowed DID)", async () => {
    expect(await blockedReason(withInamX402Gate(server402([OTHER]), registry())("https://x"))).toMatch(/payTo is not/);
    expect(await blockedReason(withInamX402Gate(server402([BOUND]), registry({ linked: "" }))("https://x"))).toMatch(/payTo is not/);
  });

  it("blocks revoked IDs and evidence or score below policy", async () => {
    expect(await blockedReason(withInamX402Gate(server402([BOUND]), registry({ revokedAt: "2026-10-01T00:00:00Z" }))("https://x"))).toMatch(/revoked/);
    expect(await blockedReason(withInamX402Gate(server402([BOUND]), registry({ evidenceLevel: "none" }))("https://x"))).toMatch(/evidence none/);
    expect(await blockedReason(withInamX402Gate(server402([BOUND]), registry({ evidenceLevel: "countersigned" }), { minEvidence: "independently_verified" })("https://x"))).toMatch(/below independently_verified/);
    expect(await blockedReason(withInamX402Gate(server402([BOUND]), registry({ trustScore: 5 }), { minTrustScore: 20 })("https://x"))).toMatch(/trustScore 5/);
  });

  it("allows a bound, reputable payee and narrows accepts to the bound address", async () => {
    const res = await withInamX402Gate(server402([OTHER, BOUND.toUpperCase().replace("0X", "0x")]), registry())("https://x");
    expect(res.status).toBe(402);
    const required = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(required.accepts.map((a: { payTo: string }) => a.payTo.toLowerCase())).toEqual([BOUND]);
    expect(required.extensions.inam.info.did).toBe(DID);
  });
});
