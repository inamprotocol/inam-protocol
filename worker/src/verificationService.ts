import * as db from "./db.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { verify } from "../../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { buildSignableVerificationContent, type VerificationContentInput } from "../../sdk-js/src/core/verificationContent.js";
import * as receiptService from "./receiptService.js";
import { getAgent } from "./agentService.js";
import type { Env, VerificationRecord } from "./types.js";

export type { VerificationContentInput };

const SUPPORTED_METHODS = ["deterministic", "agent_attestation"] as const;

/** `jobId` and `provider` are excluded on purpose — they're derived from the
 * referenced receipt (see submitVerification), never trusted from the client. */
export interface SubmitVerificationInput extends Omit<VerificationContentInput, "jobId" | "provider"> {
  signature: string;
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
export async function submitVerification(env: Env, callerDid: string, input: SubmitVerificationInput): Promise<VerificationRecord> {
  if (!SUPPORTED_METHODS.includes(input.method as (typeof SUPPORTED_METHODS)[number])) {
    throw badRequest("UNSUPPORTED_VERIFICATION_METHOD", `method must be one of: ${SUPPORTED_METHODS.join(", ")}`);
  }

  const receipt = await receiptService.getReceipt(env, input.receiptId);
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
  // v0.10: being a registered agent is not enough — a verifier must be
  // specifically operator-authorized (SPEC.md §12.3, agentService.setVerifierStatus).
  // An audit found the earlier "any registered agent that isn't a party to
  // the receipt" rule meant verifier count didn't correspond to real
  // independence at all: anyone could self-register and immediately start
  // verifying receipts. getAgent throws AGENT_NOT_FOUND for an unregistered
  // did:key; the isAuthorizedVerifier check below is the actual gate.
  const verifierAgent = await getAgent(env, callerDid);
  if (!verifierAgent.isAuthorizedVerifier) {
    throw forbidden("VERIFIER_NOT_AUTHORIZED", "This agent has not been authorized by the registry operator as a verifier");
  }
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

  // Checked before the signature, matching the Node reference exactly
  // (src/services/verificationService.ts) — a resubmission of identical
  // content is DUPLICATE_VERIFICATION regardless of what's re-sent as
  // `signature`, not INVALID_VERIFICATION_SIGNATURE. Also checked before
  // VERIFIER_ALREADY_DECIDED below: an exact resubmission (e.g. a client
  // retrying after a dropped response) is a harmless no-op and should say
  // so specifically, distinct from actually submitting a *second, different*
  // decision for the same receipt.
  if (await db.getVerification(env, verificationId)) {
    throw conflict("DUPLICATE_VERIFICATION", "A verification with identical content already exists");
  }
  // One verifier, one decision per receipt — without this, the same
  // verifier could submit a "verified" and, separately, a "rejected" for
  // the same receipt (different content, so the identical-content check
  // above doesn't catch it), and both would stand as live records
  // simultaneously with no way to tell which is authoritative.
  const existingForReceipt = await db.verificationsByReceipt(env, input.receiptId);
  if (existingForReceipt.some((v) => v.verifier === callerDid)) {
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
  try {
    await db.insertVerification(env, record);
  } catch (err) {
    if (err instanceof db.DuplicateVerificationError) {
      throw conflict("DUPLICATE_VERIFICATION", "A verification with identical content already exists");
    }
    throw err;
  }
  return record;
}

export async function getVerification(env: Env, id: string): Promise<VerificationRecord> {
  const record = await db.getVerification(env, id);
  if (!record) throw notFound("VERIFICATION_NOT_FOUND", `No verification with id ${id}`);
  return record;
}

export async function listByReceipt(env: Env, receiptId: string): Promise<VerificationRecord[]> {
  return db.verificationsByReceipt(env, receiptId);
}

/** Used by reputationService: does this receipt's independent-verification
 * evidence net out to `verified` (SPEC.md §12.5 — dispute status is checked
 * by the caller, not here)?
 *
 * v0.3 fix (was `.some(v => v.result === "verified")`): §12.3's
 * VERIFIER_ALREADY_DECIDED (added earlier in this same audit pass) stops any
 * *one* verifier from being inconsistent with itself, but never restricted
 * how many *different* verifiers can independently verify the same receipt
 * — nothing in this protocol limits that. An audit found the old rule let a
 * single `verified` outvote any number of `rejected` records from other
 * verifiers (1 verified + 9 rejected still counted as attested), which is a
 * real exploit for a receipt's own parties: get one colluding or careless
 * verifier to say "verified" and the boost applies regardless of how many
 * independent verifiers disagree.
 *
 * This is a narrow strict-majority tiebreak (verified count > rejected
 * count; a tie does NOT count as attested), not the multi-verifier
 * consensus mechanism SPEC.md §12.7 defers to v0.2 — no verifier-trust
 * weighting, no quorum requirement, no new state. It only stops the
 * previous rule's asymmetry, where a minority `verified` unconditionally
 * won. The common case (exactly one verifier submits `verified`, zero
 * `rejected`) is unaffected: 1 > 0 is still true. */
export async function hasVerifiedAttestation(env: Env, receiptId: string): Promise<boolean> {
  const records = await listByReceipt(env, receiptId);
  const verifiedCount = records.filter((v) => v.result === "verified").length;
  const rejectedCount = records.filter((v) => v.result === "rejected").length;
  return verifiedCount > rejectedCount;
}
