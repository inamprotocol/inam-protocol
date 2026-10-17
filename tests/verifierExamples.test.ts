import { it } from "vitest";
import { selfCheck as payee } from "../examples/stripe-x402/payee-check.js";
import { selfCheck as webhook } from "../examples/webhook/payment-webhook.js";

// examples/stripe-x402 and examples/webhook: offline self-checks (stubbed `inam check`, no network).
it("stripe-x402 payee check blocks fail, and caution under strict", payee);
it("webhook fulfils only when the buyer check passes and records a receipt", webhook);

// examples/verify-receipt-offline.ts against a receipt finalized by a real (in-process) registry.
import type { AddressInfo } from "node:net";
import { expect } from "vitest";
import { createServer } from "../src/server.js";
import { InamClient, generateKeypair, sha256Hex } from "../sdk-js/src/index.js";
import { verifyReceiptOffline } from "../examples/verify-receipt-offline.js";

it("offline receipt verification passes on a registry-finalized receipt and fails on tampering", async () => {
  const server = createServer().listen(0);
  await new Promise((r) => server.once("listening", r));
  try {
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const [worker, buyer] = [new InamClient(url, generateKeypair()), new InamClient(url, generateKeypair())];
    await worker.registerAgent(["demo.x"], { demo: true });
    await buyer.registerAgent(["demo.y"], { demo: true });
    const now = new Date().toISOString();
    const draft = await worker.submitWork(buyer.did, {
      jobId: "job_offline", task: { capability: "demo.x", specHash: `sha256:${sha256Hex("s")}`, createdAt: now },
      result: { outputHash: `sha256:${sha256Hex("out")}`, completedAt: now },
      settlement: { paymentRef: "stripe:pi_demo", amount: "1.00", currency: "USD" },
      verification: { method: "payer_confirmation", outcome: "success" },
    });
    const receipt = await buyer.acceptWork(draft);
    expect(verifyReceiptOffline(await buyer.getReceipt(receipt.receiptId), "out")).toEqual({ receiptId: true, workerSig: true, requesterSig: true, outputHash: true });
    expect(verifyReceiptOffline({ ...receipt, settlement: { ...receipt.settlement!, amount: "9.00" } }).receiptId).toBe(false);
  } finally {
    server.close();
  }
});
