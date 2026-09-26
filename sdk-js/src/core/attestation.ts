// SPEC.md §12.5 — shared by both runtimes so the verified-vs-rejected
// tiebreak and the evidence-level labels can't drift between them.

/** Net outcome of a receipt's counted (currently-authorized, non-revoked)
 * Verifications: strict majority wins, a tie (including 0-0) is "none". */
export type AttestationVerdict = "verified" | "rejected" | "none";

export function netVerdict(verifiedCount: number, rejectedCount: number): AttestationVerdict {
  if (verifiedCount > rejectedCount) return "verified";
  if (rejectedCount > verifiedCount) return "rejected";
  return "none";
}

/**
 * SPEC.md §5.3 (v0.32) — the strongest kind of evidence behind an agent's
 * reputation, so a consumer can't mistake a countersign-only history for
 * independently checked work by reading `trustScore` alone.
 * - `none`: no finalized receipts at all
 * - `countersigned`: finalized receipts, none independently attested
 * - `independently_verified`: at least one receipt nets out to verified
 */
export type EvidenceLevel = "none" | "countersigned" | "independently_verified";

export function evidenceLevel(finalizedReceipts: number, attestedReceipts: number): EvidenceLevel {
  if (attestedReceipts > 0) return "independently_verified";
  return finalizedReceipts > 0 ? "countersigned" : "none";
}
