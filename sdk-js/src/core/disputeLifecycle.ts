/**
 * SPEC.md §4.3 — dispute lifecycle. Pure and storage-free, same pattern as
 * receiptVisibility.ts: both runtimes' receiptService/reputationService
 * import this instead of duplicating the logic.
 *
 * Two rules live here:
 *
 * 1. Dispute right is per-party, not per-receipt. A receipt used to record
 *    a single "resolved" flag shared by both parties, so whichever party
 *    disputed-and-resolved first (self or otherwise) permanently blocked
 *    the *other* party from ever disputing — a worker could immunize its
 *    own receipt against a real requester complaint by disputing itself and
 *    immediately withdrawing. `usedBy` tracks which parties have already
 *    spent their one-shot dispute right; each party gets their own.
 * 2. An open dispute that its opener never resolves would otherwise zero
 *    out the receipt's reputation contribution forever, at no cost to the
 *    opener — a free hostage mechanism. `resolutionDeadline` (set to the
 *    same window length as the dispute-opening window itself) lets it lapse:
 *    past the deadline, an unresolved dispute stops counting as active for
 *    reputation purposes, though it can still be formally resolved later.
 */

export interface DisputeCheckable {
  status: "draft" | "finalized" | "disputed";
  dispute: {
    status: "none" | "open" | "resolved";
    resolutionDeadline?: string;
    usedBy?: string[];
  };
}

export function hasUsedDisputeRight(receipt: DisputeCheckable, callerDid: string): boolean {
  return (receipt.dispute.usedBy ?? []).includes(callerDid);
}

export function isDisputeActive(receipt: DisputeCheckable, now: number = Date.now()): boolean {
  if (receipt.status !== "disputed" || receipt.dispute.status !== "open") return false;
  if (!receipt.dispute.resolutionDeadline) return true;
  return now < new Date(receipt.dispute.resolutionDeadline).getTime();
}
