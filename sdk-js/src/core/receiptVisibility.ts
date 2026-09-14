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
  agentA: { id: string };
  agentB: { id: string };
}

export function isReceiptRestricted(receipt: VisibilityCheckable): boolean {
  return receipt.visibility === "participants_only";
}

export function isReceiptParticipant(receipt: VisibilityCheckable, callerDid: string | null | undefined): boolean {
  if (!callerDid) return false;
  return callerDid === receipt.agentA.id || callerDid === receipt.agentB.id;
}
