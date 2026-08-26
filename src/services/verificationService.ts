import { verifications } from "../storage/db.js";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errors.js";
import { verify } from "../../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { buildSignableVerificationContent, type VerificationContentInput } from "../../sdk-js/src/core/verificationContent.js";
import * as receiptService from "./receiptService.js";
import { getAgent } from "./agentService.js";
import type { VerificationRecord } from "../types.js";

export type { VerificationContentInput } from "../../sdk-js/src/core/verificationContent.js";
export { computeVerificationId, buildSignableVerificationContent } from "../../sdk-js/src/core/verificationContent.js";

const SUPPORTED_METHODS = ["deterministic", "agent_attestation"] as const;

/** `jobId` and `provider` are excluded on purpose — they're derived from the
 * referenced receipt (see submitVerification), never trusted from the client. */
export interface SubmitVerificationInput extends Omit<VerificationContentInput, "jobId" | "provider"> {
  signature: string; // base64, verifier's signature over the canonical signable content
}

/**
 * A verifier submits a complete, self-signed independent verification of a
 * finalized receipt (SPEC.md §12.3) — no draft/countersign step, unlike a
 * receipt: this is a single party's attestation, done in one call.
 *
 * `provider` and `jobId` are deliberately NOT read from client input — they
 * are derived from the referenced receipt itself, so a caller can't submit
 * an attestation that disagrees with what the receipt actually recorded.
 */
export function submitVerification(callerDid: string, input: SubmitVerificationInput): VerificationRecord {
  if (!SUPPORTED_METHODS.includes(input.method as (typeof SUPPORTED_METHODS)[number])) {
    throw badRequest("UNSUPPORTED_VERIFICATION_METHOD", `method must be one of: ${SUPPORTED_METHODS.join(", ")}`);
  }

  const receipt = receiptService.getReceipt(input.receiptId);
  if (receipt.status !== "finalized") {
    throw conflict("RECEIPT_NOT_FINALIZED", "Only a finalized receipt can be independently verified");
  }

  const provider = receipt.agentB.id;
  const requester = receipt.agentA.id;
  const jobId = receipt.jobId;

  if (callerDid !== input.verifier) {
    throw forbidden("NOT_VERIFIER", "This request must be signed by the verifier it names");
  }
  // Independence means neither party to the receipt, not just "not the
  // provider" — an audit found the requester (agentA, who already approved
  // this work by countersigning it) could name itself as the "independent"
  // verifier too, which defeats the point of an independent attestation
  // just as much as the provider self-verifying its own work would.
  if (callerDid === provider || callerDid === requester) {
    throw badRequest("SELF_VERIFICATION", "Neither party to a receipt (its provider or requester) can act as its independent verifier");
  }
  // A verifier must be a real, registered identity in this registry, not an
  // arbitrary unregistered did:key — getAgent throws AGENT_NOT_FOUND
  // otherwise. This doesn't prove the verifier is an independent
  // organization (no cryptographic scheme can, on its own — see SPEC.md §0's
  // own boundary: INAM isn't an identity/authorization system), only that
  // it's a real participant in the registry, not a throwaway key minted for
  // this one call.
  getAgent(callerDid);
  if (input.outputHash !== receipt.result.outputHash) {
    throw badRequest("VERIFICATION_TARGET_MISMATCH", "outputHash does not match the referenced receipt's result.outputHash");
  }

  const contentInput: VerificationContentInput = {
    receiptId: input.receiptId,
    jobId,
    provider,
    verifier: input.verifier,
    method: input.method,
    outputHash: input.outputHash,
    result: input.result,
    score: input.score,
    evidenceUri: input.evidenceUri,
  };
  const content = buildSignableVerificationContent(contentInput);
  const verificationId = content.verificationId;

  // Checked before VERIFIER_ALREADY_DECIDED below: an exact resubmission
  // (identical content, e.g. a client retrying after a dropped response) is
  // a harmless no-op and should say so specifically, distinct from actually
  // trying to submit a *second, different* decision for the same receipt.
  if (verifications.has(verificationId)) {
    throw conflict("DUPLICATE_VERIFICATION", "A verification with identical content already exists");
  }
  // One verifier, one decision per receipt — without this, the same
  // verifier could submit a "verified" and, separately, a "rejected" for
  // the same receipt (different content, so the identical-content check
  // above doesn't catch it), and both would stand as live records
  // simultaneously with no way to tell which is authoritative.
  if (verifications.all().some((v) => v.receiptId === input.receiptId && v.verifier === callerDid)) {
    throw conflict("VERIFIER_ALREADY_DECIDED", "This verifier has already submitted a verification for this receipt");
  }

  const signingBytes = new TextEncoder().encode(canonicalize(content));
  if (!verify(Buffer.from(input.signature, "base64"), signingBytes, callerDid)) {
    throw badRequest("INVALID_VERIFICATION_SIGNATURE", "verifier signature does not match the verification content");
  }

  const record: VerificationRecord = {
    ...content,
    createdAt: new Date().toISOString(),
    signature: input.signature,
  };
  verifications.set(verificationId, record);
  return record;
}

export function getVerification(id: string): VerificationRecord {
  const record = verifications.get(id);
  if (!record) throw notFound("VERIFICATION_NOT_FOUND", `No verification with id ${id}`);
  return record;
}

export function listByReceipt(receiptId: string): VerificationRecord[] {
  return verifications.all().filter((v) => v.receiptId === receiptId);
}

/** Used by reputationService: does this receipt have at least one `verified`
 * attestation? (SPEC.md §12.5 — dispute status is checked by the caller,
 * not here; this function only answers "was it ever independently verified".) */
export function hasVerifiedAttestation(receiptId: string): boolean {
  return listByReceipt(receiptId).some((v) => v.result === "verified");
}
