import { canonicalize } from "../crypto/canonical.js";
import { leafHash } from "./merkleLog.js";

/**
 * Append-only transparency log (audit round-2 item 6, SPEC.md v0.30, §13).
 * One entry per receipt-lifecycle event that changes what a receipt or job
 * asserts happened: finalize, dispute open/resolve, non-performance report.
 * Not job postings/offers -- receipts are the trust-bearing artifact (§4).
 *
 * The entry's canonical JSON bytes ARE what gets hashed into the log (via
 * merkleLog.ts's leafHash), so the same event logged by either runtime
 * produces byte-identical leaves -- the same "one source of truth across
 * runtimes" discipline as every other shared core module.
 */
export type TransparencyEntryType = "receipt_finalized" | "dispute_opened" | "dispute_resolved" | "nonperformance_reported";

export interface TransparencyEntryInput {
  entryType: TransparencyEntryType;
  refId: string; // receiptId for receipt/dispute events, jobId for a non-performance report
  timestamp: string; // ISO -- when the event was logged, not necessarily the underlying record's own timestamp
  data: unknown; // the relevant record snapshot at event time (e.g. the finalized receipt, or the dispute sub-object)
}

export function buildLogEntry(input: TransparencyEntryInput): { canonicalEntry: string; leafHash: string } {
  const canonicalEntry = canonicalize(input);
  return { canonicalEntry, leafHash: leafHash(new TextEncoder().encode(canonicalEntry)) };
}
