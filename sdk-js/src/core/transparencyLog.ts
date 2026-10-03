import { canonicalize } from "../crypto/canonical.js";
import { sha256Hex } from "../crypto/keys.js";
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
 *
 * v0.34: the entry commits to its payload by hash (`dataHash`) instead of
 * embedding it. The leaf can never be deleted, but the payload is stored
 * beside it and can be withheld (a participants_only receipt) or erased (a
 * data-protection request) without breaking any proof.
 */
export type TransparencyEntryType =
  | "receipt_finalized"
  | "dispute_opened"
  | "dispute_resolved"
  | "nonperformance_reported"
  | "verifier_status_changed"; // v0.39: operator grants/revokes, refId = the target agent

export interface TransparencyEntryInput {
  entryType: TransparencyEntryType;
  refId: string; // receiptId for receipt/dispute events, jobId for a non-performance report, agent DID for a verifier grant
  timestamp: string; // ISO -- when the event was logged, not necessarily the underlying record's own timestamp
  data: unknown; // the relevant record snapshot at event time (e.g. the finalized receipt, or the dispute sub-object)
}

/** `sha256:<hex>` over a payload's canonical JSON, the value an entry's `dataHash` commits to. */
export function payloadHash(canonicalPayload: string): string {
  return `sha256:${sha256Hex(canonicalPayload)}`;
}

export function buildLogEntry(input: TransparencyEntryInput): { canonicalEntry: string; leafHash: string; payload: string } {
  const { data, ...rest } = input;
  const payload = canonicalize(data);
  const canonicalEntry = canonicalize({ ...rest, dataHash: payloadHash(payload) });
  return { canonicalEntry, leafHash: leafHash(new TextEncoder().encode(canonicalEntry)), payload };
}
