import { describe, expect, it } from "vitest";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign, openDispute, resolveDispute } from "../src/services/receiptService.js";
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

  it("lets the dispute's opener resolve it (disputed -> finalized), one dispute per receipt lifetime (audit #11)", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_dispute_resolve");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
    const finalized = countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));
    const rid = finalized.receiptId;

    openDispute(rid, requester.did, "output was wrong");
    expect(computeReputation(worker.did).flags).toContain("in_dispute");

    // the disputed-against party can't clear a dispute against itself
    await expectApiError(() => resolveDispute(rid, worker.did, "please drop it"), "NOT_DISPUTE_OPENER");

    // the opener withdraws it
    const resolved = resolveDispute(rid, requester.did, "resolved off-band");
    expect(resolved.status).toBe("finalized");
    expect(resolved.dispute.status).toBe("resolved");
    expect(resolved.dispute.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(computeReputation(worker.did).flags).not.toContain("in_dispute");

    // one dispute per lifetime — can't re-dispute a resolved receipt
    await expectApiError(() => openDispute(rid, requester.did, "changed my mind"), "DISPUTE_ALREADY_RESOLVED");
    // and can't re-resolve
    await expectApiError(() => resolveDispute(rid, requester.did), "NOT_DISPUTED");
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

  it("buckets settlement volume by currency instead of summing every currency as USD", () => {
    // An audit found `components.volumeUsd` summed `settlement.amount` across
    // every currency -- a 1000 TRY receipt added 1000 to a USD-labelled
    // field, right next to a USDC one. INAM does no FX, so volume is now
    // bucketed by the currency it was actually denominated in.
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    function finalizeWith(jobId: string, settlement: Record<string, string>) {
      const input = { ...freshInput(jobId), settlement };
      const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
      const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
      countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));
    }

    finalizeWith("job_usd", { amount: "100.00", currency: "USD" });
    finalizeWith("job_try", { amount: "1000.00", currency: "TRY" });
    finalizeWith("job_eur", { amount: "50.00", currency: "eur" }); // case-insensitive
    finalizeWith("job_bad", { amount: "banana" }); // must not poison the sum with NaN

    const rep = computeReputation(worker.did);
    expect(rep.components.volumeUsd).toBe(100); // the USD receipt only, not 1150
    expect(Number.isFinite(rep.components.volumeUsd)).toBe(true);
    expect(rep.components.volumeByCurrency).toEqual({ USD: 100, TRY: 1000, EUR: 50 });
    // the role breakdown carries the same currency split, not a flat number
    expect(rep.components.asProvider.volumeByCurrency).toEqual({ USD: 100, TRY: 1000, EUR: 50 });
    expect(rep.components.asProvider.volumeUsd).toBe(100);
  });

  it("distinguishes an agent's provider history from its requester history", () => {
    // An audit found the aggregate trustScore/components don't distinguish
    // "did the work" from "requested and paid for the work" at all -- two
    // brand-new counterparties finishing one receipt ended up with
    // identical-looking reputations regardless of which side each was on.
    // agentP only ever does work (provider); agentQ both requests work from
    // agentP once and separately does work for agentR once -- so agentQ's
    // asProvider/asRequester counts should differ from each other, and
    // agentP's asRequester should be empty.
    const agentP = generateKeypair();
    const agentQ = generateKeypair();
    const agentR = generateKeypair();
    registerAgent(agentP.did, { capabilities: ["x"] });
    registerAgent(agentQ.did, { capabilities: ["job.posting", "x"] });
    registerAgent(agentR.did, { capabilities: ["job.posting"] });

    function finalize(requester: ReturnType<typeof generateKeypair>, worker: ReturnType<typeof generateKeypair>, jobId: string) {
      const input = freshInput(jobId);
      const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
      const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
      countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));
    }

    // agentQ requests work from agentP (agentQ = requester, agentP = provider).
    finalize(agentQ, agentP, "job_q_requests_from_p");
    // agentQ separately does work for agentR (agentQ = provider, agentR = requester).
    finalize(agentR, agentQ, "job_q_provides_for_r");

    const pRep = computeReputation(agentP.did);
    expect(pRep.components.asProvider.receipts).toBe(1);
    expect(pRep.components.asRequester.receipts).toBe(0);

    const qRep = computeReputation(agentQ.did);
    expect(qRep.components.asProvider.receipts).toBe(1);
    expect(qRep.components.asRequester.receipts).toBe(1);
    // Sanity: the two role counts sum to the same total the existing
    // aggregate already reports, so this is a breakdown of the same
    // underlying receipts, not a second, disconnected data source.
    expect(qRep.components.asProvider.receipts + qRep.components.asRequester.receipts).toBe(qRep.components.verifiedReceipts);
  });
});
