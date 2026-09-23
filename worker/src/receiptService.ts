import * as db from "./db.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { verify } from "../../sdk-js/src/crypto/keys.js";
import { buildSignableContent, type ReceiptContentInput } from "../../sdk-js/src/core/receiptContent.js";
import { isReceiptRestricted, isReceiptParticipant } from "../../sdk-js/src/core/receiptVisibility.js";
import { hasUsedDisputeRight } from "../../sdk-js/src/core/disputeLifecycle.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import * as jobService from "./jobService.js";
import * as transparencyService from "./transparencyService.js";
import type { Env, ExecutionReceipt } from "./types.js";

export type { ReceiptContentInput };

export interface CreateDraftInput extends ReceiptContentInput {
  agentAId: string;
  signature: string;
  visibility?: "public" | "participants_only"; // SPEC.md §4.4 (v0.19)
}

const DISPUTE_WINDOW_HOURS = 72;

// Same tolerance as request-signature clock skew (./signedRequest.ts) —
// reused for consistency, not because the two checks are the same thing.
// An audit found reputationService.ts's decay formula treats a *future*
// result.completedAt as "younger than brand new" (negative age -> decay > 1,
// unboundedly inflating that receipt's weight) rather than rejecting it —
// this is where that gets closed off, at the one place a receipt's dates are
// ever set. sdk-js/src/core/schemas.ts's isoDateTime already guarantees
// these parse to a valid instant; this adds the bounds/ordering schema
// validation alone can't.
const RECEIPT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function validateReceiptTimestamps(createdAt: string, completedAt: string): void {
  const createdMs = new Date(createdAt).getTime();
  const completedMs = new Date(completedAt).getTime();
  const nowMs = Date.now();
  if (completedMs > nowMs + RECEIPT_CLOCK_SKEW_MS) {
    throw badRequest("INVALID_TIMESTAMP", "result.completedAt cannot be in the future");
  }
  if (completedMs < createdMs) {
    throw badRequest("INVALID_TIMESTAMP", "result.completedAt cannot be before task.createdAt");
  }
}

export async function createDraft(env: Env, callerDid: string, input: CreateDraftInput): Promise<ExecutionReceipt> {
  const [worker, requester] = await Promise.all([db.getAgent(env, callerDid), db.getAgent(env, input.agentAId)]);
  if (!worker) throw notFound("AGENT_NOT_FOUND", "Worker agent must be registered before submitting receipts");
  if (!requester) throw notFound("AGENT_NOT_FOUND", "Requester agent must be registered");
  if (callerDid === input.agentAId) throw badRequest("SELF_DEALING", "agent_a and agent_b must be different agents");
  await jobService.assertReceiptMatchesJob(env, input.jobId, input.agentAId, callerDid);
  validateReceiptTimestamps(input.task.createdAt, input.result.completedAt);

  const content = buildSignableContent(input.agentAId, callerDid, input);

  const signingBytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  if (!verify(Buffer.from(input.signature, "base64"), signingBytes, callerDid)) {
    throw badRequest("INVALID_RECEIPT_SIGNATURE", "agent_b signature does not match the receipt content");
  }

  const receipt: ExecutionReceipt = {
    ...content,
    dispute: { status: "none", windowClosesAt: null },
    signatures: { agentB: input.signature },
    status: "draft",
    visibility: input.visibility ?? "public",
  };
  try {
    await db.insertDraftReceipt(env, receipt);
  } catch (err) {
    if (err instanceof db.DuplicateReceiptError) {
      throw conflict("DUPLICATE_RECEIPT", "A receipt with identical content already exists");
    }
    throw err;
  }
  return receipt;
}

export async function getReceipt(env: Env, id: string): Promise<ExecutionReceipt> {
  const r = await db.getReceipt(env, id);
  if (!r) throw notFound("RECEIPT_NOT_FOUND", `No receipt with id ${id}`);
  return r;
}

/**
 * SPEC.md §4.4 (v0.19), same reasoning as the Node reference server's
 * identical helper (src/services/receiptService.ts) — kept here rather
 * than imported to avoid a receiptService <-> verificationService import
 * cycle, since `isVerifier` needs a lookup this module can't do itself.
 */
export function isReceiptVisible(receipt: ExecutionReceipt, callerDid: string | undefined, isVerifier: boolean): boolean {
  return !isReceiptRestricted(receipt) || isReceiptParticipant(receipt, callerDid) || isVerifier;
}

export function assertReceiptVisible(receipt: ExecutionReceipt, callerDid: string | undefined, isVerifier: boolean): void {
  if (!isReceiptVisible(receipt, callerDid, isVerifier)) {
    throw forbidden("RECEIPT_NOT_VISIBLE", "This receipt is participants_only; the caller is not a party to it or a verifier who has attested it");
  }
}

export async function countersign(env: Env, receiptId: string, callerDid: string, signature: string): Promise<ExecutionReceipt> {
  const receipt = await getReceipt(env, receiptId);
  if (receipt.status !== "draft") throw conflict("NOT_DRAFT", "Only draft receipts can be countersigned");
  if (callerDid !== receipt.agentA.id) throw forbidden("NOT_REQUESTER", "Only agent_a may countersign this receipt");

  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
  const signingBytes = new TextEncoder().encode(canonicalize(content));
  if (!verify(Buffer.from(signature, "base64"), signingBytes, callerDid)) {
    throw badRequest("INVALID_RECEIPT_SIGNATURE", "agent_a signature does not match the receipt content");
  }

  const windowClosesAt = new Date(Date.now() + DISPUTE_WINDOW_HOURS * 3600_000).toISOString();
  const finalized: ExecutionReceipt = {
    ...receipt,
    signatures: { ...receipt.signatures, agentA: signature },
    dispute: { status: "none", windowClosesAt },
    status: "finalized",
  };
  const applied = await db.finalizeReceiptIfDraft(env, receiptId, finalized);
  if (!applied) {
    throw conflict("NOT_DRAFT", "Receipt was concurrently modified and is no longer in draft state");
  }
  await jobService.markCompletedByReceipt(env, finalized.jobId, receiptId);
  await transparencyService.appendEntry(env, "receipt_finalized", receiptId, finalized);
  return finalized;
}

export async function listByAgent(env: Env, agentId: string): Promise<ExecutionReceipt[]> {
  return db.receiptsByAgent(env, agentId);
}

export async function openDispute(env: Env, receiptId: string, callerDid: string, reason: string): Promise<ExecutionReceipt> {
  const receipt = await getReceipt(env, receiptId);
  if (![receipt.agentA.id, receipt.agentB.id].includes(callerDid)) {
    throw forbidden("NOT_PARTICIPANT", "Only a party to the receipt may dispute it");
  }
  // Each party gets one dispute right per receipt (SPEC.md §4.3), tracked
  // separately in dispute.usedBy — not one shared "resolved" flag, which let
  // a party immunize a receipt against the *other* party's real dispute by
  // disputing itself and immediately withdrawing.
  if (hasUsedDisputeRight(receipt, callerDid)) {
    throw conflict("DISPUTE_ALREADY_RESOLVED", "You already disputed and resolved this receipt — you cannot dispute it again");
  }
  if (receipt.status !== "finalized") throw conflict("NOT_FINALIZED", "Only finalized receipts can be disputed");
  if (!receipt.dispute.windowClosesAt || new Date(receipt.dispute.windowClosesAt).getTime() < Date.now()) {
    throw conflict("DISPUTE_WINDOW_CLOSED", "The dispute window for this receipt has closed");
  }
  // Resolution deadline — see sdk-js/src/core/disputeLifecycle.ts's doc
  // comment: past this point an unresolved dispute stops counting as active
  // for reputation, so it can't be held open forever at no cost.
  const resolutionDeadline = new Date(Date.now() + DISPUTE_WINDOW_HOURS * 3600_000).toISOString();
  const disputed: ExecutionReceipt = {
    ...receipt,
    status: "disputed",
    dispute: { ...receipt.dispute, status: "open", reason, openedBy: callerDid, resolutionDeadline },
  };
  const applied = await db.disputeReceiptIfFinalized(env, receiptId, disputed);
  if (!applied) {
    throw conflict("NOT_FINALIZED", "Receipt was concurrently modified and is no longer finalized");
  }
  await transparencyService.appendEntry(env, "dispute_opened", receiptId, disputed.dispute);
  return disputed;
}

/**
 * The dispute's opener withdraws it (SPEC.md §4.3): `disputed` -> `finalized`,
 * so the receipt counts toward reputation again. One-way — openDispute
 * rejects a re-dispute. Only the opener may do this. Not arbitration; a
 * third-party resolution authority is out of scope (§10).
 */
export async function resolveDispute(env: Env, receiptId: string, callerDid: string, note?: string): Promise<ExecutionReceipt> {
  const receipt = await getReceipt(env, receiptId);
  if (receipt.status !== "disputed" || receipt.dispute.status !== "open") {
    throw conflict("NOT_DISPUTED", "Only a receipt with an open dispute can be resolved");
  }
  if (receipt.dispute.openedBy !== callerDid) {
    throw forbidden("NOT_DISPUTE_OPENER", "Only the party that opened the dispute may resolve it");
  }
  const resolved: ExecutionReceipt = {
    ...receipt,
    status: "finalized",
    dispute: {
      ...receipt.dispute,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
      resolution: note,
      usedBy: [...(receipt.dispute.usedBy ?? []), callerDid],
    },
  };
  const applied = await db.resolveDisputeIfDisputed(env, receiptId, resolved);
  if (!applied) {
    throw conflict("NOT_DISPUTED", "Receipt was concurrently modified and is no longer disputed");
  }
  await transparencyService.appendEntry(env, "dispute_resolved", receiptId, resolved.dispute);
  return resolved;
}
