import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createServer } from "../src/server.js";
import { InamClient, generateKeypair } from "../sdk-js/src/index.js";
import { PayPal, mockPayPal } from "../examples/pay-on-proof/paypal.js";
import { openJob, settleJob, sellerDeliver, type Job, type Step } from "../examples/pay-on-proof/payOnProof.js";

// examples/paypal: PayPal money moves only against a countersigned INAM receipt.
describe("PayPal pay-on-proof", () => {
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    server = createServer().listen(0);
    await new Promise((r) => server.once("listening", r));
    url = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const setup = async () => {
    const buyer = new InamClient(url, generateKeypair());
    await buyer.registerAgent(["research.consumer"], { name: "buyer", demo: true });
    const seller = new InamClient(url, generateKeypair());
    await seller.registerAgent(["text.summary"], { name: "seller", demo: true });
    const mock = mockPayPal();
    const paypal = new PayPal({ clientId: "id", clientSecret: "secret", fetchImpl: mock.impl });
    const steps: Step[] = [];
    const ctx = { buyer, paypal, returnUrl: "http://localhost/return", cancelUrl: "http://localhost/cancel", emit: (s: Step) => steps.push(s) };
    const job = (n: string): Job => ({ jobId: `job-${n}-${Math.random().toString(36).slice(2)}`, capability: "text.summary", request: "summarize the INAM spec", amount: "12.00", currency: "USD", seller: seller.did });
    return { buyer, seller, mock, ctx, steps, job };
  };

  it("honest delivery: hold, verified receipt, then capture", async () => {
    const { buyer, seller, mock, ctx, steps, job } = await setup();
    const j = job("honest");
    const hold = await openJob(j, ctx);
    expect(hold?.approveUrl).toContain("sandbox.paypal.com");
    const out = await settleJob(j, hold!.orderId, (jj, ref) => sellerDeliver(seller, buyer.did, jj, ref, "INAM is a reputation layer."), ctx);
    expect(out).toBe("captured");
    expect(steps.map((s) => s.kind)).toEqual(["trust", "hold_created", "held", "delivered", "verified", "captured"]);
    expect((steps.find((s) => s.kind === "verified") as any).status).toBe("finalized");
    expect(mock.calls.filter((c) => c.includes("/capture"))).toHaveLength(1);
    expect(mock.calls.some((c) => c.includes("/void"))).toBe(false);
  });

  it("delivery that differs from the receipt: MISMATCH, hold voided, nothing captured", async () => {
    const { buyer, seller, mock, ctx, steps, job } = await setup();
    const j = job("swap");
    const hold = await openJob(j, ctx);
    // Seller delivers one text but signs a receipt for another.
    const out = await settleJob(j, hold!.orderId, (jj, ref) => sellerDeliver(seller, buyer.did, jj, ref, "low effort", { output: "the full report" }), ctx);
    expect(out).toBe("voided");
    expect(steps.find((s) => s.kind === "rejected")).toMatchObject({ code: "MISMATCH" });
    expect(mock.calls.some((c) => c.includes("/capture"))).toBe(false);
  });

  it("receipt claiming more money than held: MISMATCH, voided", async () => {
    const { buyer, seller, ctx, steps, job } = await setup();
    const j = job("overclaim");
    const hold = await openJob(j, ctx);
    const out = await settleJob(j, hold!.orderId, (jj, ref) => sellerDeliver(seller, buyer.did, jj, ref, "summary", { amount: "120.00" }), ctx);
    expect(out).toBe("voided");
    expect((steps.find((s) => s.kind === "rejected") as any).reason).toContain("settlement.amount");
  });

  it("seller unknown to INAM: refused before PayPal is called", async () => {
    const { mock, ctx, steps, job } = await setup();
    const j = { ...job("unknown"), seller: new InamClient(url, generateKeypair()).did };
    expect(await openJob(j, ctx)).toBeNull();
    expect(steps.map((s) => s.kind)).toEqual(["trust", "refused"]);
    expect(mock.calls).toEqual([]);
  });
});
