import { canonicalize } from "../crypto/canonical.js";
import { sha256Hex } from "../crypto/keys.js";
import type { SignableReceiptContent } from "../types.js";

/**
 * Pure, dependency-free receipt content logic shared by both the registry
 * server and any SDK/client. Deliberately has no import from
 * services/storage/middleware — an SDK package must be able to depend on
 * this without pulling in server-only code.
 */

export interface ReceiptContentInput {
  jobId: string;
  task: { capability: string; specHash: string; createdAt: string };
  result: { outputHash: string; outputUri?: string; completedAt: string };
  settlement?: { paymentRef?: string; amount?: string; currency?: string };
  verification: { method: "payer_confirmation" | "independent_validator" | "test_suite_pass"; verifier?: string; outcome: "success" | "partial" | "failed" };
}

/**
 * Receipt IDs are content-addressed: the hash of everything except the id
 * itself and the signatures/status/dispute fields that get added later. This
 * lets the worker (agent_b) compute the exact id client-side, before the
 * server has seen the receipt, so it can sign a payload that includes its own
 * id without any round-trip — and resubmitting identical content always maps
 * to the same id instead of minting a duplicate.
 */
export function computeReceiptId(agentAId: string, agentBId: string, input: ReceiptContentInput): string {
  const base = {
    jobId: input.jobId,
    agentA: { id: agentAId, role: "requester" },
    agentB: { id: agentBId, role: "worker" },
    task: input.task,
    result: input.result,
    settlement: input.settlement,
    verification: input.verification,
  };
  return `sha256:${sha256Hex(canonicalize(base))}`;
}

/** The exact object shape that must be signed — callers compute this client-side before signing. */
export function buildSignableContent(
  agentAId: string,
  agentBId: string,
  input: ReceiptContentInput,
): SignableReceiptContent {
  const receiptId = computeReceiptId(agentAId, agentBId, input);
  return {
    receiptVersion: "1.0",
    receiptId,
    jobId: input.jobId,
    agentA: { id: agentAId, role: "requester" },
    agentB: { id: agentBId, role: "worker" },
    task: input.task,
    result: input.result,
    settlement: input.settlement,
    verification: input.verification,
    dispute: { status: "none", windowClosesAt: "" }, // placeholder, excluded from signature scope in practice
  };
}
