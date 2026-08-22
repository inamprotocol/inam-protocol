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
  ReputationResult,
  JobStatus,
  JobOffer,
  JobRecord,
} from "./types.js";
