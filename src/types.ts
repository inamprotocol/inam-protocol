export interface LinkedIdentities {
  agentpass_id?: string;
  aitp_id?: string;
  passport_id?: string;
  a2a_endpoint?: string;
}

/** Key type used to prove control of an external identity's public key
 * before linking it. P-256 matches ATTP (the protocol AgentPass is built
 * on); Ed25519 is offered as the same primitive INAM's own did:key uses. */
export type ExternalKeyType = "ed25519" | "p256";

/** Response shape from POST /agents/:id/link/challenge. */
export interface LinkChallenge {
  challengeId: string;
  challenge: string; // hex-encoded random bytes, single-use, short-lived
  expiresAt: string;
}

/** Server-side record of an outstanding link challenge — never returned to
 * clients wholesale; POST /agents/:id/link/challenge returns only
 * {challengeId, challenge, expiresAt}. */
export interface LinkChallengeRecord {
  challengeId: string;
  agentId: string;
  protocol: string;
  externalPublicKey: string; // base64
  keyType: ExternalKeyType;
  challenge: string; // hex-encoded random bytes
  createdAt: string;
  expiresAt: string;
  used: boolean;
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
