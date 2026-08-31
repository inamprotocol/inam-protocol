import { receipts, agents } from "../storage/db.js";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { verify } from "../../sdk-js/src/crypto/keys.js";
import { config } from "../config.js";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errors.js";
import { buildSignableContent, type ReceiptContentInput } from "../../sdk-js/src/core/receiptContent.js";
import * as jobService from "./jobService.js";
import type { ExecutionReceipt } from "../types.js";

export type { ReceiptContentInput } from "../../sdk-js/src/core/receiptContent.js";
export { computeReceiptId, buildSignableContent } from "../../sdk-js/src/core/receiptContent.js";

export interface CreateDraftInput extends ReceiptContentInput {
  agentAId: string;
  signature: string; // base64 signature by agent_b over the canonical signable content
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
    dispute: { status: "none", windowClosesAt: "" },
    signatures: { agentB: input.signature },
    status: "draft",
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
 * Agent A (the requester/payer) countersigns a draft receipt. Only once both
 * signatures are present does the receipt become `finalized` and eligible to
 * be weighted into reputation — a unilateral submission from either side
 * never counts on its own.
 */
export function countersign(receiptId: string, callerDid: string, signature: string): ExecutionReceipt {
  const receipt = getReceipt(receiptId);
  if (receipt.status !== "draft") throw conflict("NOT_DRAFT", "Only draft receipts can be countersigned");
  if (callerDid !== receipt.agentA.id) throw forbidden("NOT_REQUESTER", "Only agent_a may countersign this receipt");

  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined };
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
  return finalized;
}

export function listByAgent(agentId: string): ExecutionReceipt[] {
  return receipts.all().filter((r) => r.agentA.id === agentId || r.agentB.id === agentId);
}

export function openDispute(receiptId: string, callerDid: string, reason: string): ExecutionReceipt {
  const receipt = getReceipt(receiptId);
  if (![receipt.agentA.id, receipt.agentB.id].includes(callerDid)) {
    throw forbidden("NOT_PARTICIPANT", "Only a party to the receipt may dispute it");
  }
  // A receipt gets one dispute in its lifetime. Once resolved it's back to
  // `finalized`, but re-disputing it would let a party toggle a receipt's
  // reputation contribution on and off at will.
  if (receipt.dispute.status === "resolved") {
    throw conflict("DISPUTE_ALREADY_RESOLVED", "This receipt was already disputed and resolved — it cannot be disputed again");
  }
  if (receipt.status !== "finalized") throw conflict("NOT_FINALIZED", "Only finalized receipts can be disputed");
  if (new Date(receipt.dispute.windowClosesAt).getTime() < Date.now()) {
    throw conflict("DISPUTE_WINDOW_CLOSED", "The dispute window for this receipt has closed");
  }
  const disputed: ExecutionReceipt = {
    ...receipt,
    status: "disputed",
    dispute: { ...receipt.dispute, status: "open", reason, openedBy: callerDid },
  };
  receipts.set(receiptId, disputed);
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
    dispute: { ...receipt.dispute, status: "resolved", resolvedAt: new Date().toISOString(), resolution: note },
  };
  receipts.set(receiptId, resolved);
  return resolved;
}
