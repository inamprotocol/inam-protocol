export interface LinkedIdentities {
  agentpass_id?: string;
  aitp_id?: string;
  passport_id?: string;
  erc8004_id?: string;
  a2a_endpoint?: string;
}

/** Key type used to prove control of an external identity's public key
 * before linking it. P-256 matches ATTP (the protocol AgentPass is built
 * on); Ed25519 is offered as the same primitive INAM's own did:key uses;
 * secp256k1 is the curve ERC-8004 (EVM) identities use. */
export type ExternalKeyType = "ed25519" | "p256" | "secp256k1";

/** How one `linked` entry was verified when it was recorded (SPEC.md §2.1).
 * `key_possession` proves control of `externalPublicKey` at `verifiedAt` — it
 * does NOT confirm that key is authoritative for the identity on the external
 * side (cross-registry resolution is out of scope, §10). `unverified_claim`
 * is an INAM-signed assertion only (`a2a_endpoint`). */
export interface LinkProof {
  method: "key_possession" | "unverified_claim";
  verifiedAt: string;
  keyType?: ExternalKeyType;
  externalPublicKey?: string; // base64; present iff method === "key_possession"
}

/** Per-protocol assurance metadata for `linked`, same keys as
 * `LinkedIdentities` (SPEC.md §2.1). */
export interface LinkedIdentityProofs {
  agentpass_id?: LinkProof;
  aitp_id?: LinkProof;
  passport_id?: LinkProof;
  erc8004_id?: LinkProof;
  a2a_endpoint?: LinkProof;
}

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
  /** Per-protocol assurance metadata for `linked` (SPEC.md §2.1) — lets a
   * consumer tell a challenge-verified link from an unverified claim. */
  linkedProof: LinkedIdentityProofs;
  stakeUsd: number;
  createdAt: string;
  /** Whether the registry operator has authorized this agent as a verifier
   * (SPEC.md §12.3) — false by default at registration. An agent cannot make
   * itself a verifier by self-registering; only the registry's configured
   * operator identity can grant this via POST /agents/:id/verifier-status. */
  isAuthorizedVerifier: boolean;
  /** ISO timestamp the agent retired this INAM ID via POST /agents/:id/revoke
   * (SPEC.md §2.2) — a one-way, self-signed tombstone for a compromised or
   * rotated-off key. Absent for an active agent. */
  revokedAt?: string;
  revocationReason?: string;
}

/** SPEC.md §4.1 — the receipt's own self-declared claim of how its parties
 *  say the work was checked, set by agent_b at draft time. **Not** the same
 *  as `IndependentVerificationMethod` (§12) below: this is unenforced today
 *  (only `payer_confirmation` carries real weight), while a Verification is
 *  a separate, signed third-party attestation resource with its own
 *  distinct `method` enum. */
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
  /** SPEC.md §4.3 (v0.22) — see sdk-js/src/types.ts's ExecutionReceipt for the full doc comment on resolutionDeadline/usedBy. */
  dispute: {
    status: DisputeStatus;
    reason?: string;
    /** null while the receipt is a draft; set when it is countersigned (SPEC §4.3). */
    windowClosesAt: string | null;
    openedBy?: string;
    resolvedAt?: string;
    resolution?: string;
    resolutionDeadline?: string;
    usedBy?: string[];
  };
  signatures: { agentB?: string; agentA?: string };
  status: ReceiptStatus;
  /** SPEC.md §4.4 (v0.19) — see sdk-js/src/types.ts's ExecutionReceipt for the full doc comment. */
  visibility?: "public" | "participants_only";
}

/** The subset of a receipt that gets signed — signatures can't sign themselves. */
export type SignableReceiptContent = Omit<ExecutionReceipt, "signatures" | "status" | "dispute"> & {
  dispute: { status: "none"; windowClosesAt: null };
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
  /** Volume denominated in USD (or untagged) only — see
   * ReputationComponents.volumeUsd/volumeByCurrency. */
  volumeUsd: number;
  /** Settlement volume bucketed by `settlement.currency`, never cross-summed. */
  volumeByCurrency: Record<string, number>;
}

export interface ReputationComponents {
  eigenWeight: number;
  verifiedReceipts: number;
  rawReceipts: number;
  successRate: number;
  /** Total settlement volume across finalized receipts denominated in USD
   * (currency `"USD"` or untagged) only. An audit found this field summed
   * every currency's raw `settlement.amount` into one USD-labelled number;
   * INAM does no FX, so non-USD volume now lives only in `volumeByCurrency`. */
  volumeUsd: number;
  /** Settlement volume bucketed by normalized `settlement.currency`
   * (uppercased; untagged -> `"USD"`), never converted or cross-summed. */
  volumeByCurrency: Record<string, number>;
  stakeUsd: number;
  decayHalfLifeDays: number;
  /** Count of finalized receipts backed by at least one `verified` Verification
   * (SPEC.md §12.5) — distinct from `verifiedReceipts` above, which really
   * means "two-party finalized," not independently attested. */
  attestedReceipts: number;
  /** Count of jobs where this agent was the accepted worker and the
   * poster later reported non-performance (SPEC.md §3.3). */
  nonPerformanceReports: number;
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

export type JobStatus = "open" | "accepted" | "completed" | "cancelled" | "nonperformed";

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
  acceptedAt?: string;
  receiptId?: string;
  createdAt: string;
  expiresAt?: string;
  // SPEC.md §3.3 (v0.25): a one-sided "the accepted worker never delivered"
  // report by the poster — set only when status transitions to
  // "nonperformed". No counterpart from the worker's side is possible by
  // design (that's exactly the case this exists for).
  nonPerformance?: { reportedAt: string; reason?: string };
}

/** SPEC.md §12 — how an independent Verification's signer actually checked
 *  the work. **Not** the same as `VerificationMethod` (§4.1) above: that's
 *  the receipt's own unenforced self-declared claim; this is a separate,
 *  first-class attestation resource's method, with its own distinct enum. */
export type IndependentVerificationMethod = "deterministic" | "agent_attestation";
export type VerificationResult = "verified" | "rejected";

/** SPEC.md §12: independent attestation that a finalized receipt's output
 * actually satisfies its job's requirements. Single verifier, no
 * draft/countersign step — complete and signed on submission. */
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
