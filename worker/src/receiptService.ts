import * as db from "./db.js";
import { canonicalize } from "../../src/crypto/canonical.js";
import { verify } from "../../src/crypto/keys.js";
import { buildSignableContent, type ReceiptContentInput } from "../../src/core/receiptContent.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { Env, ExecutionReceipt } from "./types.js";

export type { ReceiptContentInput };

export interface CreateDraftInput extends ReceiptContentInput {
  agentAId: string;
  signature: string;
}

const DISPUTE_WINDOW_HOURS = 72;

export async function createDraft(env: Env, callerDid: string, input: CreateDraftInput): Promise<ExecutionReceipt> {
  const [worker, requester] = await Promise.all([db.getAgent(env, callerDid), db.getAgent(env, input.agentAId)]);
  if (!worker) throw notFound("AGENT_NOT_FOUND", "Worker agent must be registered before submitting receipts");
  if (!requester) throw notFound("AGENT_NOT_FOUND", "Requester agent must be registered");
  if (callerDid === input.agentAId) throw badRequest("SELF_DEALING", "agent_a and agent_b must be different agents");

  const content = buildSignableContent(input.agentAId, callerDid, input);

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

export async function countersign(env: Env, receiptId: string, callerDid: string, signature: string): Promise<ExecutionReceipt> {
  const receipt = await getReceipt(env, receiptId);
  if (receipt.status !== "draft") throw conflict("NOT_DRAFT", "Only draft receipts can be countersigned");
  if (callerDid !== receipt.agentA.id) throw forbidden("NOT_REQUESTER", "Only agent_a may countersign this receipt");

  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined };
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
  if (receipt.status !== "finalized") throw conflict("NOT_FINALIZED", "Only finalized receipts can be disputed");
  if (new Date(receipt.dispute.windowClosesAt).getTime() < Date.now()) {
    throw conflict("DISPUTE_WINDOW_CLOSED", "The dispute window for this receipt has closed");
  }
  const disputed: ExecutionReceipt = {
    ...receipt,
    status: "disputed",
    dispute: { ...receipt.dispute, status: "open", reason },
  };
  const applied = await db.disputeReceiptIfFinalized(env, receiptId, disputed);
  if (!applied) {
    throw conflict("NOT_FINALIZED", "Receipt was concurrently modified and is no longer finalized");
  }
  return disputed;
}
