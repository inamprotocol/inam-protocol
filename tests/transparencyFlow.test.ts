import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { verifyInclusion, verifyConsistency } from "../sdk-js/src/core/merkleLog.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign, openDispute, resolveDispute } from "../src/services/receiptService.js";
import * as jobService from "../src/services/jobService.js";
import * as transparencyService from "../src/services/transparencyService.js";
import { ApiError } from "../src/middleware/errors.js";
import type { CreateDraftInput } from "../src/services/receiptService.js";

function expectApiError(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error(`expected ApiError ${code} but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

function signDraft(agentAId: string, agentBPrivateKey: Uint8Array, agentBId: string, input: Omit<CreateDraftInput, "signature" | "agentAId">) {
  const content = buildSignableContent(agentAId, agentBId, input);
  const bytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  return toBase64(sign(bytes, agentBPrivateKey));
}

function signCountersign(receipt: ReturnType<typeof createDraft>, agentAPrivateKey: Uint8Array) {
  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
  const bytes = new TextEncoder().encode(canonicalize(content));
  return toBase64(sign(bytes, agentAPrivateKey));
}

function freshInput(jobId: string): Omit<CreateDraftInput, "signature" | "agentAId"> {
  const now = new Date().toISOString();
  return {
    jobId,
    task: { capability: "translation.tr-en", specHash: `sha256:${createHash("sha256").update(`spec_${jobId}`).digest("hex")}`, createdAt: now },
    result: { outputHash: `sha256:${createHash("sha256").update(`out_${jobId}`).digest("hex")}`, completedAt: now },
    settlement: { amount: "12.50", currency: "USDC" },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
}

describe("transparency log lifecycle wiring", () => {
  it("appends one leaf per receipt lifecycle event and non-performance report, all independently verifiable", () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en", "x"] });

    const before = transparencyService.getSTH();

    // 1: receipt_finalized
    const input = freshInput("job_tlog_finalize");
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature: signDraft(requester.did, worker.privateKey, worker.did, input) });
    const finalized = countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));

    // 2: dispute_opened, 3: dispute_resolved
    openDispute(finalized.receiptId, requester.did, "output was wrong");
    resolveDispute(finalized.receiptId, requester.did, "resolved off-band");

    // 4: nonperformance_reported
    const job = jobService.postJob(requester.did, { capability: "x", specHash: "sha256:cd4c4cc125fb0d5bae1627b1561c1b936a64f24daa4da746d94ec90fd6bdcff5" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, requester.did, worker.did);
    try {
      vi.useFakeTimers({ now: Date.now() });
      vi.setSystemTime(Date.now() + 73 * 3600_000);
      jobService.reportNonPerformance(job.jobId, requester.did, "never delivered");
    } finally {
      vi.useRealTimers();
    }

    const after = transparencyService.getSTH();
    expect(after.treeSize).toBe(before.treeSize + 4);
    expect(after.rootHash).not.toBe(before.rootHash);

    const { entries } = transparencyService.getEntries(10, before.treeSize);
    expect(entries.map((e) => e.entryType)).toEqual(["receipt_finalized", "dispute_opened", "dispute_resolved", "nonperformance_reported"]);
    expect(entries[0].refId).toBe(finalized.receiptId);
    expect(entries[3].refId).toBe(job.jobId);

    // Every new leaf's inclusion proof verifies against the current root.
    for (let i = before.treeSize; i < after.treeSize; i++) {
      const proof = transparencyService.getInclusionProof(i, after.treeSize);
      expect(verifyInclusion(proof.leafHash, i, after.treeSize, proof.proof, after.rootHash)).toBe(true);
    }

    // The log is a provable prefix of itself as it grows: the tree at
    // `before.treeSize` is consistent with the tree at `after.treeSize`.
    const consistency = transparencyService.getConsistencyProof(before.treeSize, after.treeSize);
    expect(consistency.firstRootHash).toBe(before.rootHash);
    expect(consistency.secondRootHash).toBe(after.rootHash);
    expect(verifyConsistency(before.treeSize, before.rootHash, after.treeSize, after.rootHash, consistency.proof)).toBe(true);
  });

  it("rejects out-of-range leafIndex/treeSize on the proof endpoints", () => {
    const sth = transparencyService.getSTH();
    expectApiError(() => transparencyService.getInclusionProof(sth.treeSize + 1000, undefined), "INVALID_LEAF_INDEX");
    expectApiError(() => transparencyService.getConsistencyProof(sth.treeSize + 1000, undefined), "INVALID_TREE_SIZE");
  });
});
