import { keccak_256 } from "@noble/hashes/sha3.js";
import type { InamClient } from "./client.js";
import { canonicalize } from "./crypto/canonical.js";
import { fromBase64, toHex, verify } from "./crypto/keys.js";
import { computeReceiptId } from "./core/receiptContent.js";
import type { AgentRecord, ExecutionReceipt, ReceiptOutcome } from "./types.js";

/** INAM receipts as ERC-8004 feedback (SPEC.md §11.1).
 *
 * The receipt's requester gives the feedback from the EVM address its INAM ID
 * proved control of (`linked.erc8004_id`). The off-chain feedback file carries
 * the whole signed receipt, and `feedbackHash` commits to that file, so anyone
 * reading the on-chain feedback can check it is backed by work both parties
 * signed rather than a bare score. */

export const INAM_FEEDBACK_TAG = "inam-receipt";

const OUTCOME_VALUE: Record<ReceiptOutcome, number> = { success: 100, partial: 50, failed: 0 };

export interface Erc8004Target {
  /** `{namespace}:{chainId}:{identityRegistry}`, e.g. `eip155:8453:0x...`. */
  agentRegistry: string;
  /** The provider's ERC-721 agentId in that Identity Registry. */
  agentId: number;
  /** The provider's service endpoint the work was done on (optional). */
  endpoint?: string;
}

export interface Erc8004Feedback {
  /** The exact bytes to host at `feedbackURI`; `feedbackHash` is their keccak256. */
  fileText: string;
  feedbackHash: string;
  /** Arguments for `giveFeedback(agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash)`, minus `feedbackURI`. */
  args: { agentId: number; value: number; valueDecimals: 0; tag1: string; tag2: string; endpoint: string; feedbackHash: string };
}

/** The receipt fields both parties signed (SPEC.md §4.2-4.3), plus the signatures. */
function signedPart(r: ExecutionReceipt) {
  const { status: _s, dispute: _d, visibility: _v, ...rest } = r;
  return rest;
}

const keccakHex = (text: string) => `0x${toHex(keccak_256(new TextEncoder().encode(text)))}`;

/** Builds the feedback for a finalized, public receipt. `requester` is the receipt's agentA record, whose
 * `linked.erc8004_id` becomes `clientAddress`: the wallet that must send `giveFeedback`. */
export function buildErc8004Feedback(receipt: ExecutionReceipt, requester: AgentRecord, target: Erc8004Target, createdAt = new Date().toISOString()): Erc8004Feedback {
  if (receipt.status !== "finalized") throw new Error("only a finalized receipt can back feedback");
  if (receipt.visibility === "participants_only") throw new Error("a participants_only receipt would become public in the feedback file");
  if (requester.id !== receipt.agentA.id) throw new Error("requester must be the receipt's agentA");
  const address = requester.linked.erc8004_id;
  if (!address) throw new Error("the requester's INAM ID has no linked erc8004_id to give feedback from");

  const chain = target.agentRegistry.split(":").slice(0, 2).join(":");
  const value = OUTCOME_VALUE[receipt.verification.outcome];
  const tag2 = receipt.task.capability;
  const endpoint = target.endpoint ?? "";
  const file = {
    agentRegistry: target.agentRegistry,
    agentId: target.agentId,
    clientAddress: `${chain}:${address}`,
    createdAt,
    value,
    valueDecimals: 0,
    tag1: INAM_FEEDBACK_TAG,
    tag2,
    ...(endpoint ? { endpoint } : {}),
    inam: { receipt: signedPart(receipt) },
  };
  const fileText = canonicalize(file);
  const feedbackHash = keccakHex(fileText);
  return { fileText, feedbackHash, args: { agentId: target.agentId, value, valueDecimals: 0, tag1: INAM_FEEDBACK_TAG, tag2, endpoint, feedbackHash } };
}

export interface Erc8004FeedbackCheck {
  valid: boolean;
  /** Every check that failed; empty when valid. */
  reasons: string[];
  receiptId?: string;
  /** The provider's INAM ID and its proven EVM address. Compare the address with the on-chain agent's owner or agentWallet yourself. */
  providerDid?: string;
  providerAddress?: string;
}

/** Checks feedback read from ERC-8004 against the INAM receipt it carries. Pass the `feedbackHash` and
 * `clientAddress` from the on-chain `NewFeedback` event. The registry `inam` points at supplies the parties'
 * linked addresses and the receipt's current status; the signatures are checked locally. */
export async function verifyErc8004Feedback(
  fileText: string,
  onchain: { feedbackHash: string; clientAddress: string; value?: number },
  inam: InamClient,
): Promise<Erc8004FeedbackCheck> {
  const reasons: string[] = [];
  if (keccakHex(fileText).toLowerCase() !== onchain.feedbackHash.toLowerCase()) reasons.push("feedbackHash does not match the file");

  let file: { clientAddress?: string; value?: number; inam?: { receipt?: Omit<ExecutionReceipt, "status" | "dispute" | "visibility"> } };
  try {
    file = JSON.parse(fileText);
  } catch {
    return { valid: false, reasons: [...reasons, "file is not JSON"] };
  }
  const r = file.inam?.receipt;
  if (!r?.signatures?.agentA || !r.signatures.agentB) return { valid: false, reasons: [...reasons, "file carries no signed INAM receipt"] };

  if (computeReceiptId(r.agentA.id, r.agentB.id, r) !== r.receiptId) reasons.push("receiptId does not match the receipt content");
  const bytes = new TextEncoder().encode(canonicalize({ ...r, signatures: undefined }));
  if (!verify(fromBase64(r.signatures.agentB), bytes, r.agentB.id)) reasons.push("provider (agentB) signature is invalid");
  if (!verify(fromBase64(r.signatures.agentA), bytes, r.agentA.id)) reasons.push("requester (agentA) signature is invalid");

  const value = onchain.value ?? file.value;
  if (value !== OUTCOME_VALUE[r.verification.outcome]) reasons.push(`value ${value} does not match receipt outcome ${r.verification.outcome}`);

  const sender = onchain.clientAddress.toLowerCase();
  if (file.clientAddress && file.clientAddress.split(":").pop()!.toLowerCase() !== sender) reasons.push("file clientAddress differs from the on-chain sender");

  let requester: AgentRecord | undefined, provider: AgentRecord | undefined, stored: ExecutionReceipt | undefined;
  try {
    [requester, provider, stored] = await Promise.all([inam.getAgent(r.agentA.id), inam.getAgent(r.agentB.id), inam.getReceipt(r.receiptId)]);
  } catch {
    reasons.push("receipt or its parties not found in the registry");
  }
  if (requester && requester.linked.erc8004_id?.toLowerCase() !== sender) reasons.push("feedback was not sent from the requester's proven erc8004_id");
  if (stored && stored.status !== "finalized") reasons.push(`receipt is ${stored.status} in the registry`);

  return { valid: reasons.length === 0, reasons, receiptId: r.receiptId, providerDid: r.agentB.id, providerAddress: provider?.linked.erc8004_id };
}
