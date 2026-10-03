export { InamClient } from "./client.js";

export {
  generateKeypair,
  keypairFromPrivateKey,
  publicKeyToDid,
  didToPublicKey,
  sign,
  verify,
  verifyRawEd25519,
  sha256Hex,
  toBase64,
  fromBase64,
  toHex,
  fromHex,
  type Keypair,
} from "./crypto/keys.js";

export { generateP256Keypair, p256Sign, p256Verify, type P256Keypair } from "./crypto/p256.js";

export {
  generateSecp256k1Keypair,
  secp256k1Sign,
  secp256k1Verify,
  ethAddressFromUncompressedPublicKey,
  ethPersonalSignDigest,
  type Secp256k1Keypair,
} from "./crypto/secp256k1.js";

export { canonicalize } from "./crypto/canonical.js";

export { computeReceiptId, buildSignableContent, type ReceiptContentInput } from "./core/receiptContent.js";

// Dispute-window helpers (SPEC.md §4.3, v0.31). Use these instead of
// new Date(receipt.dispute.windowClosesAt): the field is null on drafts.
export { disputeWindowClosesAt, isDisputeWindowOpen } from "./core/disputeLifecycle.js";

export { computeVerificationId, buildSignableVerificationContent, type VerificationContentInput } from "./core/verificationContent.js";

// Transparency log (audit round-2 item 6, RFC 6962-style Merkle log): pure
// verification functions, so a caller can verify an inclusion/consistency
// proof returned by InamClient's transparency methods itself, without
// trusting the registry's own arithmetic.
export { verifyInclusion, verifyConsistency } from "./core/merkleLog.js";
export { type TransparencyEntryType, payloadHash } from "./core/transparencyLog.js";
export { type AttestationVerdict, type EvidenceLevel, type EvidenceDimensions } from "./core/attestation.js";

// Request-body validation schemas — shared by the Node reference server and
// the Cloudflare Worker so both accept/reject the exact same requests (see
// core/schemas.ts's own header comment for why this exists). Exported
// publicly too: a caller building requests by hand (rather than through
// InamClient) can validate a payload client-side before sending it.
export {
  registerAgentSchema,
  linkChallengeSchema,
  linkSchema,
  postJobSchema,
  offerSchema,
  acceptOfferSchema,
  draftReceiptSchema,
  countersignSchema,
  disputeSchema,
  submitVerificationSchema,
  setVerifierStatusSchema,
} from "./core/schemas.js";

export type {
  LinkedIdentities,
  ExternalKeyType,
  LinkChallenge,
  AgentRecord,
  VerificationMethod,
  ReceiptOutcome,
  ReceiptStatus,
  DisputeStatus,
  ExecutionReceipt,
  SignableReceiptContent,
  ReputationComponents,
  ReputationRoleBreakdown,
  ReputationResult,
  JobStatus,
  JobOffer,
  JobRecord,
  IndependentVerificationMethod,
  VerificationResult,
  VerificationRecord,
} from "./types.js";
export { INAM_X402_EXTENSION, inamX402Extension, decideX402, withInamX402Gate, X402PaymentBlocked } from "./x402.js";
export type { X402Policy, X402Decision } from "./x402.js";
export { INAM_A2A_EXTENSION_URI, inamA2AExtension, decideA2A, verifyA2ACard, cardEndpoints } from "./a2a.js";
export type { A2APolicy, A2ADecision, A2AAgentCardLike } from "./a2a.js";
export { decideTrust, checkTrust, DEFAULT_ESCROW_FLAGS } from "./trust.js";
export type { TrustPolicy, TrustDecision, TrustDecisionKind } from "./trust.js";
