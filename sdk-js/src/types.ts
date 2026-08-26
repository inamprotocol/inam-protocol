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

/** Key type used to prove control of an external identity's public key
 * before linking it (SPEC.md's external-identity linking section). P-256
 * matches ATTP (the protocol AgentPass is built on); Ed25519 is offered as
 * the same primitive INAM's own did:key already uses. */
export type ExternalKeyType = "ed25519" | "p256";

/** Response shape from POST /agents/:id/link/challenge. */
export interface LinkChallenge {
  challengeId: string;
  challenge: string; // hex-encoded random bytes, single-use, short-lived
  expiresAt: string;
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

/** Weighted receipt count/success-rate/volume for one side of an agent's
 * history — see ReputationComponents.asProvider/asRequester. Same weighting
 * (pairWeight * counterpartyTrust * decay * attestationBoost) as the
 * aggregate trustScore, just filtered to receipts where this agent held
 * that role. Not a separate 0-100 score (that's real scoring-model design
 * work, not done here) — the raw signal an aggregate trustScore currently
 * merges away. */
export interface ReputationRoleBreakdown {
  receipts: number;
  successRate: number;
  volumeUsd: number;
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
  /** This agent's history specifically as agentB (the one who did the work)
   * on its finalized receipts (SPEC.md §5.3). */
  asProvider: ReputationRoleBreakdown;
  /** This agent's history specifically as agentA (the one who requested and
   * countersigned the work) on its finalized receipts (SPEC.md §5.3). */
  asRequester: ReputationRoleBreakdown;
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
  provider: string; // did:key of the receipt's agentB — derived, not client-supplied
  verifier: string; // did:key of the caller who signed this verification
  method: IndependentVerificationMethod;
  outputHash: string; // MUST match the referenced receipt's result.outputHash
  result: VerificationResult;
  score?: number; // 0..1, optional
  evidenceUri?: string;
  createdAt: string; // server-assigned, not part of the signed content
  signature: string; // base64 Ed25519, verifier's key over the canonical signed content
}
