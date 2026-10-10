import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.js";
import { runDemo } from "../examples/payment-rails/demo.js";

// examples/payment-rails: checkTrust before each rail's checkout, a countersigned
// receipt carrying the rail's order/payment id after delivery.
describe("payment-rails example", () => {
  it("allows, escrows or denies per merchant and records each rail's id in settlement.paymentRef", async () => {
    const server = createServer().listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const results = await runDemo(`http://localhost:${(server.address() as AddressInfo).port}`);
      expect(results).toEqual([
        { rail: "Stripe ACP", decision: "allow", paymentRef: "acp:order_acp_456", status: "finalized" },
        { rail: "UCP", decision: "allow", paymentRef: "ucp:ord_99887766", status: "finalized" },
        { rail: "Visa TAP", decision: "escrow", paymentRef: "visa-tap:ORD-20261010-0001", status: "finalized" },
        { rail: "Mastercard Agent Pay", decision: "escrow", paymentRef: "mastercard-agent-pay:pay_mc_789", status: "finalized" },
        { rail: "Google AP2", decision: "deny" },
      ]);
    } finally {
      server.close();
    }
  });
});
