import { canonicalize } from "../crypto/canonical.js";
import { fromBase64, verify } from "../crypto/keys.js";

/**
 * Key succession (SPEC.md §2.3, v0.42). An INAM ID is its key, so "rotating"
 * means handing the identity's history to a new ID. Both keys sign the same
 * statement: the old key proves control of the identity, the new key proves
 * the successor exists and agreed. Shared by both runtimes and the SDK, same
 * "one source of truth" rule as receiptContent.ts.
 */
export const SUCCESSION_TYPE = "inam.succession.v1";

/** SPEC.md §2.3: a succession takes effect this long after it is requested.
 *  Until then the old key can cancel it by revoking, which burns the ID. */
export const SUCCESSION_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Registry clock for succession deadlines. Tests replace `now` to step past
 *  the window; nothing else should. */
export const successionClock = { now: (): number => Date.now() };

export interface SuccessionStatement {
  type: typeof SUCCESSION_TYPE;
  predecessor: string;
  successor: string;
}

/** What both keys sign, and the payload of the `agent_succeeded` log entry. */
export interface SuccessionRecord extends SuccessionStatement {
  predecessorSignature: string; // base64 Ed25519 by the predecessor's key
  successorSignature: string; // base64 Ed25519 by the successor's key
}

/** A requested succession during its window (SPEC.md §2.3), on the predecessor's record. */
export interface PendingSuccession extends SuccessionRecord {
  requestedAt: string;
  effectiveAt: string;
}

/** The exact bytes both keys sign: canonical JSON of the statement, UTF-8. */
export function successionSigningBytes(predecessor: string, successor: string): Uint8Array {
  const statement: SuccessionStatement = { type: SUCCESSION_TYPE, predecessor, successor };
  return new TextEncoder().encode(canonicalize(statement));
}

/** True only if both signatures verify over the statement. Checkable offline by anyone. */
export function verifySuccession(r: Pick<SuccessionRecord, "predecessor" | "successor" | "predecessorSignature" | "successorSignature">): boolean {
  if (r.predecessor === r.successor) return false;
  try {
    const bytes = successionSigningBytes(r.predecessor, r.successor);
    return verify(fromBase64(r.predecessorSignature), bytes, r.predecessor) && verify(fromBase64(r.successorSignature), bytes, r.successor);
  } catch {
    return false; // malformed DID or base64
  }
}

/** predecessor -> successor, for every succeeded ID in a registry. */
export type SuccessionMap = ReadonlyMap<string, string>;

// Chains are acyclic by construction (a successor must be unregistered), so
// the cap is only a guard against a corrupted store, not a protocol limit.
const MAX_HOPS = 64;

/** The current (last) ID in `did`'s chain. Reputation counts a counterparty under this ID. */
export function headOf(did: string, map: SuccessionMap): string {
  let cur = did;
  for (let i = 0; i < MAX_HOPS && map.has(cur); i++) cur = map.get(cur)!;
  return cur;
}

/** `did` followed by its predecessors, newest first. Reputation for `did` is computed over all of them. */
export function lineageOf(did: string, map: SuccessionMap): string[] {
  const back = new Map<string, string>();
  for (const [p, s] of map) back.set(s, p);
  const out = [did];
  for (let i = 0; i < MAX_HOPS && back.has(out[out.length - 1]); i++) out.push(back.get(out[out.length - 1])!);
  return out;
}
