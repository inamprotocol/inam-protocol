import { checkTrust, sha256Hex, type InamClient, type ExecutionReceipt, type TrustPolicy, type TrustDecision } from "../../sdk-js/src/index.js";

/** Pay on proof: an agent may move money only against a verified INAM receipt.
 * The rail is PayPal (fiat) or USDC over x402 (crypto); the receipt and the
 * reputation it builds are the same on both.
 *
 *   1. checkTrust(seller)          deny  -> stop, no rail is ever called
 *   2. rail.hold + confirm          PayPal AUTHORIZE / a signed, unsubmitted x402 payload; nothing moves
 *   3. seller delivers + drafts an INAM receipt naming the hold (settlement.paymentRef)
 *   4. buyer.acceptWork(receipt, { outputHash of what was delivered, amount, currency })
 *        match           -> countersign, then rail.capture
 *        MISMATCH /
 *        NOT_COMPARED    -> rail.void; the payer is never charged
 *
 * These gates are plain code. An AI agent can choose sellers, write the job and
 * explain decisions, but it cannot change a gate: capture is only reachable
 * through a countersigned receipt. */

export type Step =
  | { kind: "trust"; decision: TrustDecision["decision"]; reasons: string[] }
  | { kind: "refused"; reason: string }
  | { kind: "hold_created"; rail: string; holdRef: string; approveUrl?: string }
  | { kind: "held"; ref: string; amount: string; currency: string; expiresAt?: string }
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

/** A payment rail that can hold, then capture or release. `name` prefixes settlement.paymentRef. */
export interface Rail {
  name: string;
  hold(job: Job, urls: { returnUrl: string; cancelUrl: string }): Promise<{ holdRef: string; approveUrl?: string }>;
  confirm(holdRef: string): Promise<{ ref: string; amount: string; currency: string; expiresAt?: string }>;
  capture(ref: string, note: string): Promise<{ captureId: string; status: string }>;
  void(ref: string): Promise<{ status: string }>;
}

export interface Ctx {
  buyer: InamClient;
  rail: Rail;
  policy?: TrustPolicy;
  returnUrl: string;
  cancelUrl: string;
  emit?: (s: Step) => void;
}

/** Steps 1-2. Returns the hold (and approval link, if the rail has one), or null when the seller is refused before any rail call. */
export async function openJob(job: Job, ctx: Ctx): Promise<{ holdRef: string; approveUrl?: string } | null> {
  const emit = ctx.emit ?? (() => {});
  const trust = await checkTrust(job.seller, ctx.buyer, ctx.policy);
  emit({ kind: "trust", decision: trust.decision, reasons: trust.reasons });
  if (trust.decision === "deny") {
    emit({ kind: "refused", reason: trust.reasons.join("; ") });
    return null;
  }
  // allow and escrow both go through the hold: pay-on-proof never pays up front.
  const hold = await ctx.rail.hold(job, { returnUrl: ctx.returnUrl, cancelUrl: ctx.cancelUrl });
  emit({ kind: "hold_created", rail: ctx.rail.name, ...hold });
  return hold;
}

/** Steps 2-4, after the owner approved the hold. `deliver` is the seller doing the work. */
export async function settleJob(job: Job, holdRef: string, deliver: (job: Job, paymentRef: string) => Promise<Delivery>, ctx: Ctx): Promise<"captured" | "voided"> {
  const emit = ctx.emit ?? (() => {});
  const held = await ctx.rail.confirm(holdRef);
  emit({ kind: "held", ...held });
  if (held.amount !== job.amount || held.currency !== job.currency) {
    // The rail held something other than what the job says: never capture it.
    emit({ kind: "rejected", code: "HOLD_MISMATCH", reason: `held ${held.amount} ${held.currency}, job is ${job.amount} ${job.currency}` });
    emit({ kind: "voided", ...(await ctx.rail.void(held.ref)) });
    return "voided";
  }

  const paymentRef = `${ctx.rail.name}:${held.ref}`;
  let d: Delivery;
  try {
    d = await deliver(job, paymentRef);
  } catch (e) {
    emit({ kind: "rejected", code: "NOT_DELIVERED", reason: (e as Error).message });
    emit({ kind: "voided", ...(await ctx.rail.void(held.ref)) });
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
    emit({ kind: "voided", ...(await ctx.rail.void(held.ref)) });
    return "voided";
  }
  emit({ kind: "verified", receiptId: receipt.receiptId, status: receipt.status });
  const cap = await ctx.rail.capture(held.ref, `Paid on verified INAM receipt ${receipt.receiptId}`);
  emit({ kind: "captured", ...cap });
  return "captured";
}

/** Seller side: do the work, then draft the receipt naming the hold. */
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
