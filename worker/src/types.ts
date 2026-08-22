export interface LinkedIdentities {
  agentpass_id?: string;
  aitp_id?: string;
  passport_id?: string;
  a2a_endpoint?: string;
}

export type ExternalKeyType = "ed25519" | "p256";

/** Response shape from POST /agents/:id/link/challenge. */
export interface LinkChallenge {
  challengeId: string;
  challenge: string;
  expiresAt: string;
}

/** Server-side record, stored in the IDEMPOTENCY KV namespace under
 * `link-challenge:<id>` with a matching TTL — never returned to clients
 * wholesale. */
export interface LinkChallengeRecord {
  challengeId: string;
  agentId: string;
  protocol: string;
  externalPublicKey: string;
  keyType: ExternalKeyType;
  challenge: string;
  createdAt: string;
  expiresAt: string;
  used: boolean;
}

export interface AgentRecord {
  id: string;
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

export interface ReputationComponents {
  eigenWeight: number;
  verifiedReceipts: number;
  rawReceipts: number;
  successRate: number;
  volumeUsd: number;
  stakeUsd: number;
  decayHalfLifeDays: number;
  /** Count of finalized receipts backed by at least one `verified` Verification
   * (SPEC.md §12.5) — distinct from `verifiedReceipts` above, which really
   * means "two-party finalized," not independently attested. */
  attestedReceipts: number;
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
  postedBy: string;
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

/** SPEC.md §12: independent attestation that a finalized receipt's output
 * actually satisfies its job's requirements. Single verifier, no
 * draft/countersign step — complete and signed on submission. */
export type IndependentVerificationMethod = "deterministic" | "agent_attestation";
export type VerificationResult = "verified" | "rejected";

export interface VerificationRecord {
  verificationVersion: "1.0";
  verificationId: string;
  receiptId: string;
  jobId: string;
  provider: string;
  verifier: string;
  method: IndependentVerificationMethod;
  outputHash: string;
  result: VerificationResult;
  score?: number;
  evidenceUri?: string;
  createdAt: string;
  signature: string;
}

export interface Env {
  DB: D1Database;
  IDEMPOTENCY: KVNamespace;
  RATE_LIMIT_REGISTER: RateLimit;
  RATE_LIMIT_WRITE: RateLimit;
  RATE_LIMIT_READ: RateLimit;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { agentDid?: string; rawBody?: string; parsedBody?: unknown };
};
