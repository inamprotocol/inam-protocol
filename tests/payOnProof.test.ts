import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/server.js";
import { InamClient, generateKeypair, generateSecp256k1Keypair } from "../sdk-js/src/index.js";
import { PayPal, PayPalRail, mockPayPal } from "../examples/pay-on-proof/paypal.js";
import { X402Rail, BASE_SEPOLIA, addressOf, domainSeparator, mockFacilitator } from "../examples/pay-on-proof/x402rail.js";
import { openJob, settleJob, sellerDeliver, type Job, type Rail, type Step } from "../examples/pay-on-proof/payOnProof.js";

// examples/pay-on-proof: money moves only against a countersigned INAM receipt, on either rail.
const RAILS = {
  paypal: { currency: "USD", refPrefix: "paypal:", capture: "/capture" },
  usdc: { currency: "USDC", refPrefix: "x402:eip155:84532:0x", capture: "/settle" },
} as const;

let server: http.Server;
let url: string;
let buyer: InamClient;
let seller: InamClient; // one seller on both rails: one reputation
beforeAll(async () => {
  server = createServer().listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  buyer = new InamClient(url, generateKeypair());
  await buyer.registerAgent(["research.consumer"], { name: "buyer", demo: true });
  seller = new InamClient(url, generateKeypair());
  await seller.registerAgent(["text.summary"], { name: "seller", demo: true });
});
afterAll(() => server.close());

describe.each(Object.keys(RAILS) as (keyof typeof RAILS)[])("pay-on-proof on %s", (railName) => {
  const R = RAILS[railName];
  const setup = () => {
    let calls: string[];
    let rail: Rail;
    if (railName === "paypal") {
      const mock = mockPayPal();
      calls = mock.calls;
      rail = new PayPalRail(new PayPal({ clientId: "id", clientSecret: "secret", fetchImpl: mock.impl }));
    } else {
      const mock = mockFacilitator();
      calls = mock.calls;
      const key = Buffer.from(generateSecp256k1Keypair().privateKey).toString("hex");
      rail = new X402Rail({ buyerPrivateKey: key, payTo: addressOf(generateSecp256k1Keypair().privateKey), fetchImpl: mock.impl });
    }
    const steps: Step[] = [];
    const ctx = { buyer, rail, returnUrl: "http://localhost/return", cancelUrl: "http://localhost/cancel", emit: (s: Step) => steps.push(s) };
    const job = (n: string): Job => ({ jobId: `job-${n}-${Math.random().toString(36).slice(2)}`, capability: "text.summary", request: "summarize the INAM spec", amount: "12.00", currency: R.currency, seller: seller.did });
    return { calls, ctx, steps, job };
  };

  it("honest delivery: hold, verified receipt, then capture", async () => {
    const { calls, ctx, steps, job } = setup();
    const j = job("honest");
    const hold = await openJob(j, ctx);
    const out = await settleJob(j, hold!.holdRef, (jj, ref) => sellerDeliver(seller, buyer.did, jj, ref, "INAM is a reputation layer."), ctx);
    expect(out).toBe("captured");
    expect(steps.map((s) => s.kind)).toEqual(["trust", "hold_created", "held", "delivered", "verified", "captured"]);
    const verified = steps.find((s) => s.kind === "verified") as Extract<Step, { kind: "verified" }>;
    expect(verified.status).toBe("finalized");
    // The countersigned receipt names the rail's hold.
    const receipt = await buyer.getReceipt(verified.receiptId);
    expect(receipt.settlement?.paymentRef?.startsWith(R.refPrefix)).toBe(true);
    expect(calls.filter((c) => c.endsWith(R.capture))).toHaveLength(1);
    expect(calls.some((c) => c.endsWith("/void"))).toBe(false);
    if (railName === "usdc") expect(calls).toEqual(["POST /facilitator/verify", "POST /facilitator/settle"]);
  });

  it("delivery that differs from the receipt: MISMATCH, hold released, nothing captured", async () => {
    const { calls, ctx, steps, job } = setup();
    const j = job("swap");
    const hold = await openJob(j, ctx);
    // Seller delivers one text but signs a receipt for another.
    const out = await settleJob(j, hold!.holdRef, (jj, ref) => sellerDeliver(seller, buyer.did, jj, ref, "low effort", { output: "the full report" }), ctx);
    expect(out).toBe("voided");
    expect(steps.find((s) => s.kind === "rejected")).toMatchObject({ code: "MISMATCH" });
    expect(calls.some((c) => c.endsWith(R.capture))).toBe(false);
    if (railName === "usdc") {
      expect(calls).toEqual([]); // the signed payload never left the buyer
      expect((steps.find((s) => s.kind === "voided") as Extract<Step, { kind: "voided" }>).status).toMatch(/^DISCARDED \(expires /);
    }
  });

  it("receipt claiming more money than held: MISMATCH, released", async () => {
    const { calls, ctx, steps, job } = setup();
    const j = job("overclaim");
    const hold = await openJob(j, ctx);
    const out = await settleJob(j, hold!.holdRef, (jj, ref) => sellerDeliver(seller, buyer.did, jj, ref, "summary", { amount: "120.00" }), ctx);
    expect(out).toBe("voided");
    expect((steps.find((s) => s.kind === "rejected") as Extract<Step, { kind: "rejected" }>).reason).toContain("settlement.amount");
    expect(calls.some((c) => c.endsWith(R.capture))).toBe(false);
  });

  it("seller unknown to INAM: refused before the rail is called", async () => {
    const { calls, ctx, steps, job } = setup();
    const j = { ...job("unknown"), seller: new InamClient(url, generateKeypair()).did };
    expect(await openJob(j, ctx)).toBeNull();
    expect(steps.map((s) => s.kind)).toEqual(["trust", "refused"]);
    expect(calls).toEqual([]);
  });
});

it("one reputation across rails: the seller's two honest jobs (USD via PayPal, USDC via x402) both count", async () => {
  const rep = await buyer.getReputation(seller.did);
  expect(rep.components.finalizedReceipts).toBe(2);
});

it("x402 EIP-712 domain matches Base Sepolia USDC's on-chain DOMAIN_SEPARATOR()", () => {
  // Read once via eth_call on sepolia.base.org; pins the name/version/chainId/contract encoding.
  expect(Buffer.from(domainSeparator(BASE_SEPOLIA)).toString("hex")).toBe("71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818");
});
