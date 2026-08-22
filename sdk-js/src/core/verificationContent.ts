import { canonicalize } from "../crypto/canonical.js";
import { sha256Hex } from "../crypto/keys.js";
import type { IndependentVerificationMethod, VerificationResult } from "../types.js";

/**
 * Pure, dependency-free verification content logic (SPEC.md §12) — same
 * "shared by server and any SDK/client" contract as receiptContent.ts.
 */

export interface VerificationContentInput {
  receiptId: string;
  jobId: string;
  provider: string;
  verifier: string;
  method: IndependentVerificationMethod;
  outputHash: string;
  result: VerificationResult;
  score?: number;
  evidenceUri?: string;
}

/** Content-addressed, same principle as computeReceiptId (SPEC.md §12.2). */
export function computeVerificationId(input: VerificationContentInput): string {
  return `sha256:${sha256Hex(canonicalize({ ...input }))}`;
}

/** The exact object shape that must be signed — mirrors buildSignableContent:
 * embeds the already-computed verificationId alongside the fields that were
 * hashed to produce it. */
export function buildSignableVerificationContent(input: VerificationContentInput): { verificationVersion: "1.0"; verificationId: string } & VerificationContentInput {
  const verificationId = computeVerificationId(input);
  return { verificationVersion: "1.0", verificationId, ...input };
}
