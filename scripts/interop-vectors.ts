import { keypairFromPrivateKey, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { buildSignableVerificationContent } from "../sdk-js/src/core/verificationContent.js";
import { buildSignableContent } from "../sdk-js/src/core/receiptContent.js";
import { buildErc8004Feedback } from "../sdk-js/src/erc8004.js";
import type { AgentRecord, ExecutionReceipt } from "../sdk-js/src/types.js";

// Fixed 32-byte private key (all 0x01) purely for cross-language test vectors —
// never use a fixed key for anything real.
const FIXED_PRIVATE_KEY = new Uint8Array(32).fill(1);
const { did, publicKey } = keypairFromPrivateKey(FIXED_PRIVATE_KEY);

const sampleObject = {
  jobId: "job_interop_1",
  agentA: { id: "did:key:zExampleA", role: "requester" },
  agentB: { id: "did:key:zExampleB", role: "worker" },
  task: { capability: "translation.tr-en", specHash: "sha256:spec", createdAt: "2026-08-22T00:00:00.000Z" },
  result: { outputHash: "sha256:out", completedAt: "2026-08-22T00:01:00.000Z" },
  settlement: { amount: "12.50", currency: "USDC" },
  verification: { method: "payer_confirmation", outcome: "success" },
};
const canonical = canonicalize(sampleObject);

const message = new TextEncoder().encode("inam-interop-test-message");
const signature = sign(message, FIXED_PRIVATE_KEY);

const verificationInput = {
  receiptId: "sha256:receipt_interop_1",
  jobId: "job_interop_1",
  provider: "did:key:zExampleProvider",
  verifier: did,
  method: "deterministic" as const,
  outputHash: "sha256:out",
  result: "verified" as const,
  score: 0.98,
};
const verificationContent = buildSignableVerificationContent(verificationInput);
const verificationCanonical = canonicalize(verificationContent);
const verificationSignature = sign(new TextEncoder().encode(verificationCanonical), FIXED_PRIVATE_KEY);

// ERC-8004 feedback (SPEC.md §11.1): fixed keys 0x01.. (requester) and 0x02.. (provider).
const requesterKey = keypairFromPrivateKey(FIXED_PRIVATE_KEY);
const providerKey = keypairFromPrivateKey(new Uint8Array(32).fill(2));
const receiptContent = buildSignableContent(requesterKey.did, providerKey.did, {
  jobId: "job_interop_8004",
  task: { capability: "translation.tr-en", specHash: `sha256:${"a".repeat(64)}`, createdAt: "2026-10-01T10:00:00.000Z" },
  result: { outputHash: `sha256:${"b".repeat(64)}`, completedAt: "2026-10-01T10:05:00.000Z" },
  settlement: { amount: "12.50", currency: "USDC" },
  verification: { method: "payer_confirmation", outcome: "success" },
});
const receiptBytes = new TextEncoder().encode(canonicalize({ ...receiptContent, dispute: undefined }));
const erc8004Receipt = {
  ...receiptContent,
  dispute: { status: "none", windowClosesAt: "2026-10-04T10:05:00.000Z" },
  signatures: { agentB: toBase64(sign(receiptBytes, providerKey.privateKey)), agentA: toBase64(sign(receiptBytes, requesterKey.privateKey)) },
  status: "finalized",
  visibility: "public",
} as ExecutionReceipt;
const erc8004 = buildErc8004Feedback(
  erc8004Receipt,
  { id: requesterKey.did, linked: { erc8004_id: "0x1111111111111111111111111111111111111111" } } as unknown as AgentRecord,
  { agentRegistry: "eip155:8453:0x0000000000000000000000000000000000008004", agentId: 7 },
  "2026-10-03T00:00:00.000Z",
);

console.log(
  JSON.stringify(
    {
      privateKeyHex: Buffer.from(FIXED_PRIVATE_KEY).toString("hex"),
      publicKeyHex: Buffer.from(publicKey).toString("hex"),
      did,
      canonical,
      messageUtf8: "inam-interop-test-message",
      signatureBase64: toBase64(signature),
      verification: {
        verificationId: verificationContent.verificationId,
        canonical: verificationCanonical,
        signatureBase64: toBase64(verificationSignature),
      },
      erc8004: { receipt: erc8004Receipt, fileText: erc8004.fileText, feedbackHash: erc8004.feedbackHash },
    },
    null,
    2,
  ),
);
