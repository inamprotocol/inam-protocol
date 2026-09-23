import { receipts, agents } from "../storage/db.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { verify } from "../../sdk-js/src/crypto/keys.js";
import { config } from "../config.js";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errors.js";
import { buildSignableContent, type ReceiptContentInput } from "../../sdk-js/src/core/receiptContent.js";
import { isReceiptRestricted, isReceiptParticipant } from "../../sdk-js/src/core/receiptVisibility.js";
import { hasUsedDisputeRight } from "../../sdk-js/src/core/disputeLifecycle.js";
import * as jobService from "./jobService.js";
import * as transparencyService from "./transparencyService.js";
import type { ExecutionReceipt } from "../types.js";

export type { ReceiptContentInput } from "../../sdk-js/src/core/receiptContent.js";
export { computeReceiptId, buildSignableContent } from "../../sdk-js/src/core/receiptContent.js";

export interface CreateDraftInput extends ReceiptContentInput {
  agentAId: string;
  signature: string; // base64 signature by agent_b over the canonical signable content
  visibility?: "public" | "participants_only"; // SPEC.md §4.4 (v0.19)
}

// Same tolerance as request-signature clock skew (src/middleware/signedRequest.ts)
// — reused for consistency, not because the two checks are the same thing.
// An audit found reputationService.ts's decay formula treats a *future*
// result.completedAt as "younger than brand new" (negative age -> decay > 1,
// unboundedly inflating that receipt's weight) rather than rejecting it —
// this is where that gets closed off, at the one place a receipt's dates are
// ever set. schemas.ts's isoDateTime already guarantees these parse to a
// valid instant; this adds the bounds/ordering schema validation alone can't.
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

/**
 * Agent B (the worker) submits a draft receipt, signing the receipt content
 * with its own key. This signature is independent of the HTTP request
 * signature: it is the long-lived, portable proof that travels with the
 * receipt itself, verifiable by anyone holding the JSON — not just by this
 * server.
 */
export function createDraft(callerDid: string, input: CreateDraftInput): ExecutionReceipt {
  if (!agents.has(callerDid)) throw notFound("AGENT_NOT_FOUND", "Worker agent must be registered before submitting receipts");
  if (!agents.has(input.agentAId)) throw notFound("AGENT_NOT_FOUND", "Requester agent must be registered");
  if (callerDid === input.agentAId) throw badRequest("SELF_DEALING", "agent_a and agent_b must be different agents");
  jobService.assertReceiptMatchesJob(input.jobId, input.agentAId, callerDid);
  validateReceiptTimestamps(input.task.createdAt, input.result.completedAt);

  const content = buildSignableContent(input.agentAId, callerDid, input);
  const receiptId = content.receiptId;

  if (receipts.has(receiptId)) {
    throw conflict("DUPLICATE_RECEIPT", "A receipt with identical content already exists");
  }

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
  receipts.set(receiptId, receipt);
  return receipt;
}

export function getReceipt(id: string): ExecutionReceipt {
  const r = receipts.get(id);
  if (!r) throw notFound("RECEIPT_NOT_FOUND", `No receipt with id ${id}`);
  return r;
}

/**
 * SPEC.md §4.4 (v0.19): a `participants_only` receipt is visible in full
 * only to its two parties or a verifier who has attested it. `isVerifier`
 * is supplied by the caller (route layer) rather than looked up here —
 * verificationService already imports this module, so importing it back
 * would be circular; the route layer already has both services in scope.
 */
export function isReceiptVisible(receipt: ExecutionReceipt, callerDid: string | undefined, isVerifier: boolean): boolean {
  return !isReceiptRestricted(receipt) || isReceiptParticipant(receipt, callerDid) || isVerifier;
}

export function assertReceiptVisible(receipt: ExecutionReceipt, callerDid: string | undefined, isVerifier: boolean): void {
  if (!isReceiptVisible(receipt, callerDid, isVerifier)) {
    throw forbidden("RECEIPT_NOT_VISIBLE", "This receipt is participants_only; the caller is not a party to it or a verifier who has attested it");
  }
}

/**
 * Agent A (the requester/payer) countersigns a draft receipt. Only once both
 * signatures are present does the receipt become `finalized` and eligible to
 * be weighted into reputation — a unilateral submission from either side
 * never counts on its own.
 */
export function countersign(receiptId: string, callerDid: string, signature: string): ExecutionReceipt {
  const receipt = getReceipt(receiptId);
  if (receipt.status !== "draft") throw conflict("NOT_DRAFT", "Only draft receipts can be countersigned");
  if (callerDid !== receipt.agentA.id) throw forbidden("NOT_REQUESTER", "Only agent_a may countersign this receipt");

  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
  const signingBytes = new TextEncoder().encode(canonicalize(content));
  if (!verify(Buffer.from(signature, "base64"), signingBytes, callerDid)) {
    throw badRequest("INVALID_RECEIPT_SIGNATURE", "agent_a signature does not match the receipt content");
  }

  const windowClosesAt = new Date(Date.now() + config.disputeWindowHours * 3600_000).toISOString();
  const finalized: ExecutionReceipt = {
    ...receipt,
    signatures: { ...receipt.signatures, agentA: signature },
    dispute: { status: "none", windowClosesAt },
    status: "finalized",
  };
  receipts.set(receiptId, finalized);
  jobService.markCompletedByReceipt(finalized.jobId, receiptId);
  transparencyService.appendEntry("receipt_finalized", receiptId, finalized);
  return finalized;
}

export function listByAgent(agentId: string): ExecutionReceipt[] {
  return receipts.listByAgent(agentId);
}

export function openDispute(receiptId: string, callerDid: string, reason: string): ExecutionReceipt {
  const receipt = getReceipt(receiptId);
  if (![receipt.agentA.id, receipt.agentB.id].includes(callerDid)) {
    throw forbidden("NOT_PARTICIPANT", "Only a party to the receipt may dispute it");
  }
  // Each party gets one dispute right per receipt, tracked separately
  // (dispute.usedBy) — not one shared "resolved" flag. A shared flag let a
  // party immunize a receipt against the *other* party's real dispute by
  // disputing itself and immediately withdrawing (resolveDispute is
  // opener-only, so the immunizer needed no cooperation from anyone).
  if (hasUsedDisputeRight(receipt, callerDid)) {
    throw conflict("DISPUTE_ALREADY_RESOLVED", "You already disputed and resolved this receipt — you cannot dispute it again");
  }
  if (receipt.status !== "finalized") throw conflict("NOT_FINALIZED", "Only finalized receipts can be disputed");
  if (!receipt.dispute.windowClosesAt || new Date(receipt.dispute.windowClosesAt).getTime() < Date.now()) {
    throw conflict("DISPUTE_WINDOW_CLOSED", "The dispute window for this receipt has closed");
  }
  // Resolution deadline: an open dispute the opener never resolves would
  // otherwise zero out the receipt's reputation contribution forever at no
  // cost — a free hostage mechanism. Past this deadline it stops counting
  // as active for reputation (reputationService.isDisputeActive), though it
  // can still be formally resolved later. Same window length as opening.
  const resolutionDeadline = new Date(Date.now() + config.disputeWindowHours * 3600_000).toISOString();
  const disputed: ExecutionReceipt = {
    ...receipt,
    status: "disputed",
    dispute: { ...receipt.dispute, status: "open", reason, openedBy: callerDid, resolutionDeadline },
  };
  receipts.set(receiptId, disputed);
  transparencyService.appendEntry("dispute_opened", receiptId, disputed.dispute);
  return disputed;
}

/**
 * The party that opened the dispute withdraws it (SPEC.md §4.3) — the
 * `disputed` state's only exit. Moves the receipt back to `finalized`, so it
 * counts toward reputation again and the `in_dispute` flag clears. One-way:
 * a resolved receipt can't be re-disputed (openDispute rejects it). Only the
 * opener may do this — the disputed-against party clearing a dispute against
 * itself would defeat the point. This is not arbitration (no third party
 * decides who was right); that stays out of scope (§10).
 */
export function resolveDispute(receiptId: string, callerDid: string, note?: string): ExecutionReceipt {
  const receipt = getReceipt(receiptId);
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
  receipts.set(receiptId, resolved);
  transparencyService.appendEntry("dispute_resolved", receiptId, resolved.dispute);
  return resolved;
}
