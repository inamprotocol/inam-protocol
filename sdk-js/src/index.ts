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

export { canonicalize } from "./crypto/canonical.js";

export { computeReceiptId, buildSignableContent, type ReceiptContentInput } from "./core/receiptContent.js";

export { computeVerificationId, buildSignableVerificationContent, type VerificationContentInput } from "./core/verificationContent.js";

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
