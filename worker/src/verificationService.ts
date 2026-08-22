import * as db from "./db.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { verify } from "../../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { buildSignableVerificationContent, type VerificationContentInput } from "../../sdk-js/src/core/verificationContent.js";
import * as receiptService from "./receiptService.js";
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
  const jobId = receipt.jobId;

  if (callerDid !== input.verifier) {
    throw forbidden("NOT_VERIFIER", "This request must be signed by the verifier it names");
  }
  if (callerDid === provider) {
    throw badRequest("SELF_VERIFICATION", "A receipt's own provider (agentB) cannot verify their own work");
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
  // `signature`, not INVALID_VERIFICATION_SIGNATURE.
  if (await db.getVerification(env, verificationId)) {
    throw conflict("DUPLICATE_VERIFICATION", "A verification with identical content already exists");
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

/** Used by reputationService: does this receipt have at least one `verified`
 * attestation? (SPEC.md §12.5 — dispute status is checked by the caller,
 * not here; this function only answers "was it ever independently verified".) */
export async function hasVerifiedAttestation(env: Env, receiptId: string): Promise<boolean> {
  const records = await listByReceipt(env, receiptId);
  return records.some((v) => v.result === "verified");
}
