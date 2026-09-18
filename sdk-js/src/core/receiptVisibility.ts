/**
 * SPEC.md §4.4 — receipt visibility. A `participants_only` receipt is
 * readable in full only by its two parties or by an agent that has
 * submitted a Verification (§12) referencing it; everyone else gets
 * `RECEIPT_NOT_VISIBLE`. `public` (the default, and every pre-v0.19
 * receipt with no `visibility` field) is unrestricted, as before.
 *
 * Deliberately pure and storage-free: whether the caller is a verifier
 * requires a lookup into each runtime's own verification storage, which
 * would create a receiptService <-> verificationService import cycle
 * (verificationService already imports receiptService in both runtimes) —
 * so that check stays at the route layer, which already imports both
 * services. This module only encodes the two checks that need no lookup.
 */

export interface VisibilityCheckable {
  visibility?: "public" | "participants_only";
  status?: string;
  agentA: { id: string };
  agentB: { id: string };
}

/**
 * A `draft` receipt is restricted regardless of its own `visibility` field —
 * only agentB (the drafter) has consented to anything at draft time, so a
 * `visibility: "public"` a drafter unilaterally chose isn't the requester's
 * (agentA's) consent to expose it. An external review found this let anyone
 * name any registered agent as agentA on an unbounded number of drafts, all
 * publicly visible immediately with no involvement from the named agent
 * (300 garbage "failed" drafts in one repro) — outcome/content freely chosen
 * by whoever calls createDraft, landing in the named victim's public record
 * before they've had any chance to react. Once countersigned (finalized) or
 * disputed, both parties have acted on it and the chosen visibility applies
 * as normal.
 */
export function isReceiptRestricted(receipt: VisibilityCheckable): boolean {
  return receipt.visibility === "participants_only" || receipt.status === "draft";
}

export function isReceiptParticipant(receipt: VisibilityCheckable, callerDid: string | null | undefined): boolean {
  if (!callerDid) return false;
  return callerDid === receipt.agentA.id || callerDid === receipt.agentB.id;
}
