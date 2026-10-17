import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { checkTarget, parsePaymentRequired, paymentOptions, type CheckReport } from "../../sdk-js/src/index.js";

/** `inam check` on the payTo of an x402 payment, before the payment is signed.
 *
 * Stripe's machine payments accept x402 (USDC on Base): the seller answers 402 with a
 * `payTo` deposit address, and the buyer's x402 client signs a payment to it. This
 * wrapper sits INSIDE that client's fetch, so a failing payee throws before anything
 * is signed. It is the same check as `npx inam check 0x...` (SPEC.md section 11.2 and
 * sdk-js/src/check.ts); it reports public signals (ERC-8004, INAM wallet link and
 * receipts), not a guarantee.
 *
 * INAM moves and holds no money. It never touches your Stripe account, keys or funds;
 * the payment itself stays on x402 / Stripe. A fresh per-payment deposit address has
 * no history, so expect "caution" for brand-new payees: strict:true refuses them,
 * strict:false (default) only refuses a "fail". Choose deliberately.
 *
 *   npx tsx examples/stripe-x402/payee-check.ts     # offline self-check, no network */

export class PayeeBlocked extends Error {
  constructor(public payTo: string, public report: CheckReport) {
    super(`payee ${payTo} blocked: ${report.verdict}`);
  }
}

export function withInamPayeeCheck(
  inner: typeof fetch,
  opts: { strict?: boolean; check?: (target: string) => Promise<CheckReport> } = {},
): typeof fetch {
  const check = opts.check ?? ((t: string) => checkTarget(t));
  return async (input, init) => {
    const res = await inner(input, init);
    if (res.status !== 402) return res;
    const required = parsePaymentRequired(res.headers, await res.clone().text());
    for (const { payTo } of paymentOptions(required)) {
      const report = await check(payTo);
      if (report.verdict === "fail" || (opts.strict && report.verdict === "caution")) throw new PayeeBlocked(payTo, report);
    }
    return res; // every payTo passed: hand the 402 to the x402 payer, which signs and retries
  };
}

/** Offline self-check: a stub `check` stands in for the network lookups. */
export async function selfCheck() {
  const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", C = "0x3333333333333333333333333333333333333333";
  const verdicts: Record<string, CheckReport["verdict"]> = { [A]: "pass", [B]: "caution", [C]: "fail" };
  const check = async (t: string): Promise<CheckReport> => ({ target: t, kind: "wallet", verdict: verdicts[t], checkedAt: "", checks: [] });
  const seller = (payTo: string): typeof fetch => async () =>
    new Response(null, { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: "USDC", payTo }] })).toString("base64") } });
  const get = (payTo: string, strict = false) => withInamPayeeCheck(seller(payTo), { strict, check })("https://seller.example/api");

  assert.equal((await get(A)).status, 402); // passes through to the payer
  assert.equal((await get(B)).status, 402); // caution, lenient
  await assert.rejects(get(B, true), PayeeBlocked); // caution, strict
  await assert.rejects(get(C), PayeeBlocked); // fail
  console.log("stripe-x402 payee-check: ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await selfCheck();
