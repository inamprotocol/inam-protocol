import { describe, expect, it } from "vitest";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign, openDispute } from "../src/services/receiptService.js";
import { computeReputation } from "../src/services/reputationService.js";
import { ApiError } from "../src/middleware/errors.js";
import type { CreateDraftInput } from "../src/services/receiptService.js";

function signDraft(agentAId: string, agentBPrivateKey: Uint8Array, agentBId: string, input: Omit<CreateDraftInput, "signature" | "agentAId">) {
  const content = buildSignableContent(agentAId, agentBId, input);
  const bytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  return toBase64(sign(bytes, agentBPrivateKey));
}

function signCountersign(receipt: ReturnType<typeof createDraft>, agentAPrivateKey: Uint8Array) {
  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined };
  const bytes = new TextEncoder().encode(canonicalize(content));
  return toBase64(sign(bytes, agentAPrivateKey));
}

async function expectApiError(fn: () => unknown, code: string) {
  try {
    await fn();
    throw new Error(`expected ApiError ${code} but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

function freshInput(jobId: string): Omit<CreateDraftInput, "signature" | "agentAId"> {
  const now = new Date().toISOString();
  return {
    jobId,
    task: { capability: "translation.tr-en", specHash: `sha256:spec_${jobId}`, createdAt: now },
    result: { outputHash: `sha256:out_${jobId}`, completedAt: now },
    settlement: { amount: "12.50", currency: "USDC" },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
}

describe("execution receipt lifecycle", () => {
  it("moves draft -> finalized only once both signatures verify, and feeds reputation", () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    for (const jobId of ["job_1", "job_2"]) {
      const input = freshInput(jobId);
      const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
      const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
      expect(draft.status).toBe("draft");

      const counterSig = signCountersign(draft, requester.privateKey);
      const finalized = countersign(draft.receiptId, requester.did, counterSig);
      expect(finalized.status).toBe("finalized");
    }

    const reputation = computeReputation(worker.did);
    expect(reputation.components.verifiedReceipts).toBe(2);
    expect(reputation.components.successRate).toBe(1);
    expect(reputation.trustScore).toBeGreaterThan(0);
  });

  it("rejects a draft whose signature does not match its content", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    const impostor = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_bad_sig");
    // Signed by the wrong key, then submitted claiming to be `worker`.
    const badSignature = signDraft(requester.did, impostor.privateKey, worker.did, input);

    await expectApiError(
      () => createDraft(worker.did, { ...input, agentAId: requester.did, signature: badSignature }),
      "INVALID_RECEIPT_SIGNATURE",
    );
  });

  it("rejects self-dealing (agent_a and agent_b must differ)", async () => {
    const solo = generateKeypair();
    registerAgent(solo.did, { capabilities: ["translation.tr-en"] });
    const input = freshInput("job_self_deal");
    const signature = signDraft(solo.did, solo.privateKey, solo.did, input);

    await expectApiError(() => createDraft(solo.did, { ...input, agentAId: solo.did, signature }), "SELF_DEALING");
  });

  it("treats resubmission of identical content as a duplicate rather than a new receipt", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_dup");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    createDraft(worker.did, { ...input, agentAId: requester.did, signature });

    await expectApiError(() => createDraft(worker.did, { ...input, agentAId: requester.did, signature }), "DUPLICATE_RECEIPT");
  });

  it("rejects a countersign from anyone other than agent_a", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_wrong_countersigner");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
    const counterSig = signCountersign(draft, stranger.privateKey);

    await expectApiError(() => countersign(draft.receiptId, stranger.did, counterSig), "NOT_REQUESTER");
  });

  it("allows a participant to open a dispute within the window, and rejects a non-participant", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_dispute");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
    const finalized = countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));

    await expectApiError(() => openDispute(finalized.receiptId, stranger.did, "not involved"), "NOT_PARTICIPANT");

    const disputed = openDispute(finalized.receiptId, requester.did, "output was wrong");
    expect(disputed.status).toBe("disputed");
    expect(disputed.dispute.status).toBe("open");

    const reputation = computeReputation(worker.did);
    expect(reputation.flags).toContain("in_dispute");
  });

  it("rejects a future result.completedAt beyond clock-skew tolerance", async () => {
    // An audit found reputationService.ts's decay formula treats a future
    // completedAt as *younger than brand new* (negative age -> decay > 1),
    // unboundedly inflating that receipt's weight. Closed at the source: a
    // receipt with a future completedAt is now rejected at submission.
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const jobId = "job_future_completed";
    const future = new Date(Date.now() + 60 * 24 * 3600_000).toISOString(); // 60 days from now
    const input = {
      jobId,
      task: { capability: "translation.tr-en", specHash: `sha256:spec_${jobId}`, createdAt: future },
      result: { outputHash: `sha256:out_${jobId}`, completedAt: future },
      settlement: { amount: "12.50", currency: "USDC" },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    await expectApiError(() => createDraft(worker.did, { ...input, agentAId: requester.did, signature }), "INVALID_TIMESTAMP");
  });

  it("rejects result.completedAt before task.createdAt", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const jobId = "job_out_of_order_dates";
    const now = new Date();
    const created = now.toISOString();
    const completedBeforeCreated = new Date(now.getTime() - 3600_000).toISOString(); // 1 hour earlier
    const input = {
      jobId,
      task: { capability: "translation.tr-en", specHash: `sha256:spec_${jobId}`, createdAt: created },
      result: { outputHash: `sha256:out_${jobId}`, completedAt: completedBeforeCreated },
      settlement: { amount: "12.50", currency: "USDC" },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    await expectApiError(() => createDraft(worker.did, { ...input, agentAId: requester.did, signature }), "INVALID_TIMESTAMP");
  });
});
