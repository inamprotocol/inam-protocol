import http from "node:http";
import { pathToFileURL } from "node:url";
import { InamClient, generateKeypair, checkTrust, type TrustDecisionKind } from "../../sdk-js/src/index.js";
import { acp, ucp, visaTap, mastercardAgentPay, ap2, writeReceipt, mockMerchant, type Rail } from "./rails.js";

/** One buyer agent shops at five merchants, one per rail: check trust, pay on the
 * rail (mocked), get the work, then the merchant drafts a receipt with the rail's
 * id and the buyer countersigns it.
 *
 *   npx tsx examples/payment-rails/demo.ts
 *
 * With no INAM_URL it starts a throwaway in-process registry. Local only: it writes receipts. */
export async function runDemo(inamUrl: string, log: (line: string) => void = () => {}) {
  const buyer = new InamClient(inamUrl, generateKeypair());
  await buyer.registerAgent(["research.consumer"], { name: "rails demo buyer", demo: true });

  // A merchant with one countersigned job behind it, a brand-new one, and an ID the registry never saw.
  const established = new InamClient(inamUrl, generateKeypair());
  await established.registerAgent(["research.report"], { name: "rails demo merchant", demo: true });
  const first = await writeReceipt(established, buyer.did, "research.report", "earlier order", "earlier report", { paymentRef: "acp:order_prior", amount: "10.00", currency: "USD" });
  await buyer.acceptWork(first, { amount: "10.00", currency: "USD" });
  const newcomer = new InamClient(inamUrl, generateKeypair());
  await newcomer.registerAgent(["research.report"], { name: "rails demo newcomer", demo: true });
  const unknown = new InamClient(inamUrl, generateKeypair());

  // Countersigned history is enough to pay up front here; the SDK default asks for independently verified.
  const policy = { allow: { minEvidence: "countersigned" as const } };
  const shops: [string, Rail, InamClient][] = [
    ["Stripe ACP", acp, established],
    ["UCP", ucp, established],
    ["Visa TAP", visaTap, newcomer],
    ["Mastercard Agent Pay", mastercardAgentPay, established],
    ["Google AP2", ap2, unknown],
  ];

  const results: { rail: string; decision: TrustDecisionKind; paymentRef?: string; status?: string }[] = [];
  for (const [rail, pay, merchant] of shops) {
    // 1. Before payment.
    const trust = await checkTrust(merchant.did, buyer, policy);
    log(`\n${rail}: ${trust.decision} (${trust.reasons.join("; ")})`);
    if (trust.decision === "deny") {
      results.push({ rail, decision: trust.decision });
      continue;
    }
    // "escrow" means: don't release money before delivery. INAM holds none, so use the
    // rail's own hold (card authorize now, capture after the receipt is countersigned).
    const settlement = await pay(mockMerchant);
    log(`   paid ${settlement.amount} ${settlement.currency}${trust.decision === "escrow" ? " (authorized, capture held until delivery)" : ""}, rail id ${settlement.paymentRef}`);

    // 2. After delivery.
    const draft = await writeReceipt(merchant, buyer.did, "research.report", "market report, EU", `report for ${settlement.paymentRef}`, settlement);
    const receipt = await buyer.acceptWork(draft, { amount: settlement.amount, currency: settlement.currency });
    log(`   receipt ${receipt.receiptId} ${receipt.status}, settlement.paymentRef ${receipt.settlement?.paymentRef}`);
    results.push({ rail, decision: trust.decision, paymentRef: receipt.settlement?.paymentRef, status: receipt.status });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let url = process.env.INAM_URL;
  let registry: http.Server | undefined;
  if (!url) {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    process.env.INAM_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inam-rails-demo-")); // read by src/config.ts at import
    const { createServer } = await import("../../src/server.js");
    registry = createServer().listen(0);
    await new Promise((r) => registry!.once("listening", r));
    url = `http://localhost:${(registry.address() as { port: number }).port}`;
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) throw new Error("refusing to write to a non-local registry");
  await runDemo(url, console.log);
  registry?.close();
}
