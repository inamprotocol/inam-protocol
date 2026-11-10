import { checkTrust, sha256Hex, type InamClient, type ExecutionReceipt, type TrustPolicy, type TrustDecision } from "../../sdk-js/src/index.js";
import type { PayPal } from "./paypal.js";

/** Pay on proof: an agent may move PayPal money only against a verified INAM receipt.
 *
 *   1. checkTrust(seller)          deny  -> stop, PayPal is never called
 *   2. PayPal order, AUTHORIZE      the owner approves once; money is held, not moved
 *   3. seller delivers + drafts an INAM receipt naming the PayPal authorization
 *   4. buyer.acceptWork(receipt, { outputHash of what was delivered, amount, currency })
 *        match           -> countersign, then PayPal capture
 *        MISMATCH /
 *        NOT_COMPARED    -> PayPal void; the payer is never charged
 *
 * These gates are plain code. An AI agent can choose sellers, write the job and
 * explain decisions, but it cannot change a gate: capture is only reachable
 * through a countersigned receipt. */

export type Step =
  | { kind: "trust"; decision: TrustDecision["decision"]; reasons: string[] }
  | { kind: "refused"; reason: string }
  | { kind: "hold_created"; orderId: string; approveUrl: string }
  | { kind: "held"; authorizationId: string; amount: string; currency: string }
  | { kind: "delivered"; outputHash: string; receiptClaims: { outputHash?: string; amount?: string; currency?: string } }
  | { kind: "verified"; receiptId: string; status: string }
  | { kind: "captured"; captureId: string; status: string }
  | { kind: "rejected"; code: string; reason: string }
  | { kind: "voided"; status: string };

export interface Job {
  jobId: string;
  capability: string;
  request: string;
  amount: string;
  currency: string;
  seller: string; // seller's INAM ID (did:key)
  payeeEmail?: string;
}

export interface Delivery {
  output: string;
  receipt: ExecutionReceipt; // the seller's draft, signed by the seller
}

export interface Ctx {
  buyer: InamClient;
  paypal: PayPal;
  policy?: TrustPolicy;
  returnUrl: string;
  cancelUrl: string;
  emit?: (s: Step) => void;
}

/** Steps 1-2. Returns the approval link, or null when the seller is refused before any PayPal call. */
export async function openJob(job: Job, ctx: Ctx): Promise<{ orderId: string; approveUrl: string } | null> {
  const emit = ctx.emit ?? (() => {});
  const trust = await checkTrust(job.seller, ctx.buyer, ctx.policy);
  emit({ kind: "trust", decision: trust.decision, reasons: trust.reasons });
  if (trust.decision === "deny") {
    emit({ kind: "refused", reason: trust.reasons.join("; ") });
    return null;
  }
  // allow and escrow both go through the hold: pay-on-proof never pays up front.
  const hold = await ctx.paypal.createHold({ jobId: job.jobId, description: `${job.capability}: ${job.request}`, amount: job.amount, currency: job.currency, payeeEmail: job.payeeEmail, returnUrl: ctx.returnUrl, cancelUrl: ctx.cancelUrl });
  emit({ kind: "hold_created", ...hold });
  return hold;
}

/** Steps 2-4, after the owner approved the order. `deliver` is the seller doing the work. */
export async function settleJob(job: Job, orderId: string, deliver: (job: Job, paymentRef: string) => Promise<Delivery>, ctx: Ctx): Promise<"captured" | "voided"> {
  const emit = ctx.emit ?? (() => {});
  const held = await ctx.paypal.authorize(orderId);
  emit({ kind: "held", ...held });
  if (held.amount !== job.amount || held.currency !== job.currency) {
    // PayPal held something other than what the job says: never capture it.
    emit({ kind: "rejected", code: "HOLD_MISMATCH", reason: `held ${held.amount} ${held.currency}, job is ${job.amount} ${job.currency}` });
    emit({ kind: "voided", ...(await ctx.paypal.void(held.authorizationId)) });
    return "voided";
  }

  const paymentRef = `paypal:${held.authorizationId}`;
  let d: Delivery;
  try {
    d = await deliver(job, paymentRef);
  } catch (e) {
    emit({ kind: "rejected", code: "NOT_DELIVERED", reason: (e as Error).message });
    emit({ kind: "voided", ...(await ctx.paypal.void(held.authorizationId)) });
    return "voided";
  }
  const outputHash = `sha256:${sha256Hex(d.output)}`;
  emit({ kind: "delivered", outputHash, receiptClaims: { outputHash: d.receipt.result?.outputHash, amount: d.receipt.settlement?.amount, currency: d.receipt.settlement?.currency } });

  let receipt: ExecutionReceipt;
  try {
    // What we received and what we hold, never what the receipt says about itself.
    receipt = await ctx.buyer.acceptWork(d.receipt, { outputHash, jobId: job.jobId, amount: job.amount, currency: job.currency });
  } catch (e) {
    const err = e as Error & { code?: string };
    emit({ kind: "rejected", code: err.code ?? "REFUSED", reason: err.message });
    emit({ kind: "voided", ...(await ctx.paypal.void(held.authorizationId)) });
    return "voided";
  }
  emit({ kind: "verified", receiptId: receipt.receiptId, status: receipt.status });
  const cap = await ctx.paypal.capture(held.authorizationId, `Paid on verified INAM receipt ${receipt.receiptId}`);
  emit({ kind: "captured", ...cap });
  return "captured";
}

/** Seller side: do the work, then draft the receipt naming the PayPal authorization. */
export async function sellerDeliver(seller: InamClient, buyerDid: string, job: Job, paymentRef: string, output: string, claim: { output?: string; amount?: string } = {}): Promise<Delivery> {
  const now = new Date().toISOString();
  const receipt = await seller.submitWork(buyerDid, {
    jobId: job.jobId,
    task: { capability: job.capability, specHash: `sha256:${sha256Hex(job.request)}`, createdAt: now },
    result: { outputHash: `sha256:${sha256Hex(claim.output ?? output)}`, completedAt: now },
    settlement: { paymentRef, amount: claim.amount ?? job.amount, currency: job.currency },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  return { output, receipt };
}
