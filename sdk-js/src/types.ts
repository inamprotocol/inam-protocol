/**
 * Wire-format types for the INAM Protocol REST API. This is the JS/TS SDK's
 * own copy — parity with `sdk-python/inamprotocol/types` and the registry
 * server's `src/types.ts` — kept in sync by hand rather than shared, since
 * these are plain data shapes with no logic to drift.
 */

export interface LinkedIdentities {
  agentpass_id?: string;
  aitp_id?: string;
  passport_id?: string;
  a2a_endpoint?: string;
}

export interface AgentRecord {
  id: string; // did:key:...
  capabilities: string[];
  metadata: Record<string, unknown>;
  linked: LinkedIdentities;
  stakeUsd: number;
  createdAt: string;
}

export type VerificationMethod = "payer_confirmation" | "independent_validator" | "test_suite_pass";
export type ReceiptOutcome = "success" | "partial" | "failed";
export type ReceiptStatus = "draft" | "finalized" | "disputed";
export type DisputeStatus = "none" | "open" | "resolved";

export interface ExecutionReceipt {
  receiptVersion: "1.0";
  receiptId: string;
  jobId: string;
  agentA: { id: string; role: "requester" };
  agentB: { id: string; role: "worker" };
  task: { capability: string; specHash: string; createdAt: string };
  result: { outputHash: string; outputUri?: string; completedAt: string };
  settlement?: { paymentRef?: string; amount?: string; currency?: string };
  verification: { method: VerificationMethod; verifier?: string; outcome: ReceiptOutcome };
  dispute: { status: DisputeStatus; reason?: string; windowClosesAt: string };
  signatures: { agentB?: string; agentA?: string };
  status: ReceiptStatus;
}

/** The subset of a receipt that gets signed — signatures can't sign themselves. */
export type SignableReceiptContent = Omit<ExecutionReceipt, "signatures" | "status" | "dispute"> & {
  dispute: { status: "none"; windowClosesAt: string };
};

export interface ReputationComponents {
  eigenWeight: number;
  verifiedReceipts: number;
  rawReceipts: number;
  successRate: number;
  volumeUsd: number;
  stakeUsd: number;
  decayHalfLifeDays: number;
}

export interface ReputationResult {
  trustScore: number;
  components: ReputationComponents;
  flags: string[];
}

export type JobStatus = "open" | "accepted" | "completed" | "cancelled";

export interface JobOffer {
  agentId: string;
  message?: string;
  createdAt: string;
}

export interface JobRecord {
  jobId: string;
  postedBy: string; // agent_a's INAM ID
  capability: string;
  specHash: string;
  budget?: { amount?: string; currency?: string };
  status: JobStatus;
  offers: JobOffer[];
  acceptedAgentId?: string;
  receiptId?: string;
  createdAt: string;
  expiresAt?: string;
}
