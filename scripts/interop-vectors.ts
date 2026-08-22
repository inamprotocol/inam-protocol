import { keypairFromPrivateKey, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { buildSignableVerificationContent } from "../sdk-js/src/core/verificationContent.js";

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
    },
    null,
    2,
  ),
);
