import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { canonicalize, computeReceiptId, verify, fromBase64, sha256Hex, type ExecutionReceipt } from "../sdk-js/src/index.js";

/** Verify a finalized receipt with no registry and no network (SPEC.md sections 2, 4.2, 4.3, 5.4).
 * Input: the receipt JSON, and optionally the output bytes it claims to hash. Each check
 * is deterministic: it either holds for anyone holding the JSON or it does not.
 *
 *   npx tsx examples/verify-receipt-offline.ts     # self-check on a locally built receipt */
export function verifyReceiptOffline(r: ExecutionReceipt, output?: string) {
  const bytes = new TextEncoder().encode(canonicalize({ ...r, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined }));
  return {
    receiptId: computeReceiptId(r.agentA.id, r.agentB.id, r) === r.receiptId, // content-addressed id (4.2)
    workerSig: verify(fromBase64(r.signatures.agentB ?? ""), bytes, r.agentB.id), // key is inside the did:key (2)
    requesterSig: verify(fromBase64(r.signatures.agentA ?? ""), bytes, r.agentA.id),
    outputHash: output === undefined ? null : `sha256:${sha256Hex(output)}` === r.result.outputHash, // null = not checked
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { generateKeypair, publicKeyToDid, buildSignableContent, sign, toBase64 } = await import("../sdk-js/src/index.js");
  const [a, b] = [generateKeypair(), generateKeypair()];
  const [aDid, bDid] = [publicKeyToDid(a.publicKey), publicKeyToDid(b.publicKey)];
  const output = "the report";
  const now = new Date().toISOString();
  const input = { jobId: "job_demo", task: { capability: "demo.x", specHash: `sha256:${sha256Hex("spec")}`, createdAt: now }, result: { outputHash: `sha256:${sha256Hex(output)}`, completedAt: now }, verification: { method: "payer_confirmation" as const, outcome: "success" as const } };
  const { dispute, ...content } = buildSignableContent(aDid, bDid, input);
  const bytes = new TextEncoder().encode(canonicalize(content));
  const receipt = { ...content, dispute, signatures: { agentB: toBase64(sign(bytes, b.privateKey)), agentA: toBase64(sign(bytes, a.privateKey)) }, status: "finalized", visibility: "public" } as unknown as ExecutionReceipt;
  assert.deepEqual(verifyReceiptOffline(receipt, output), { receiptId: true, workerSig: true, requesterSig: true, outputHash: true });
  assert.equal(verifyReceiptOffline(receipt, "tampered").outputHash, false);
  assert.equal(verifyReceiptOffline({ ...receipt, result: { ...receipt.result, completedAt: "2030-01-01T00:00:00Z" } }).receiptId, false);
  console.log("verify-receipt-offline: ok");
}
