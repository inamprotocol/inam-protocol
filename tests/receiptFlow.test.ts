import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
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
    task: { capability: "translation.tr-en", specHash: `sha256:${createHash("sha256").update(`spec_${jobId}`).digest("hex")}`, createdAt: now },
    result: { outputHash: `sha256:${createHash("sha256").update(`out_${jobId}`).digest("hex")}`, completedAt: now },
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

  it("lets the other party still dispute after one party disputes-and-resolves its own copy (closes a self-immunization exploit)", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_dispute_immunize");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
    const finalized = countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));
    const rid = finalized.receiptId;

    // worker (agent_b) preemptively disputes its own receipt and immediately
    // withdraws it, trying to burn the receipt's one-shot "already resolved"
    // gate before the requester ever gets a chance to raise a real dispute.
    openDispute(rid, worker.did, "self-check");
    resolveDispute(rid, worker.did);

    // requester's real dispute must still go through — worker using its own
    // dispute right must not consume requester's separate right.
    const disputed = openDispute(rid, requester.did, "output was actually wrong");
    expect(disputed.status).toBe("disputed");

    // requester, having now used its own right by resolving, can't re-dispute
    resolveDispute(rid, requester.did);
    await expectApiError(() => openDispute(rid, requester.did, "changed my mind again"), "DISPUTE_ALREADY_RESOLVED");
    // and worker's right is spent too, from its own earlier dispute
    await expectApiError(() => openDispute(rid, worker.did, "one more try"), "DISPUTE_ALREADY_RESOLVED");
  });

  it("stops counting an unresolved dispute as active once its resolution deadline passes (no free-forever hostage)", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("job_dispute_expiry");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
    const finalized = countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));
    const rid = finalized.receiptId;

    openDispute(rid, requester.did, "output was wrong");
    expect(computeReputation(worker.did).flags).toContain("in_dispute");
    expect(computeReputation(worker.did).components.verifiedReceipts).toBe(0);

    try {
      vi.useFakeTimers({ now: Date.now() });
      vi.setSystemTime(Date.now() + 73 * 3600_000); // just past the 72h resolution deadline, still never resolved
      const rep = computeReputation(worker.did);
      expect(rep.flags).not.toContain("in_dispute");
      expect(rep.components.verifiedReceipts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flags a Sybil ring spread across many counterparties that the per-pair concentration check can't catch (v0.24)", () => {
    // An external review reproduced this against a local copy: a hub-spoke
    // ring of many sockpuppet identities, each individually below the 60%
    // per-pair concentration threshold, pushed a target's trustScore to a
    // "green" level with zero warning flags. None of the feeders here has
    // any transaction history outside the target's own counterparty set —
    // that's the signal the per-pair check structurally can't see.
    const target = generateKeypair();
    registerAgent(target.did, { capabilities: ["x"] });

    const feeders = Array.from({ length: 5 }, () => generateKeypair());
    for (const feeder of feeders) registerAgent(feeder.did, { capabilities: ["job.posting"] });

    for (const feeder of feeders) {
      for (let i = 0; i < 3; i++) {
        const jobId = `ring_${feeder.did.slice(-6)}_${i}`;
        const input = freshInput(jobId);
        const signature = signDraft(feeder.did, target.privateKey, target.did, input);
        const draft = createDraft(target.did, { ...input, agentAId: feeder.did, signature });
        countersign(draft.receiptId, feeder.did, signCountersign(draft, feeder.privateKey));
      }
    }

    const reputation = computeReputation(target.did);
    expect(reputation.components.rawReceipts).toBe(15);
    // No single feeder is concentrated (3/15 = 20% << 60%) — the existing
    // per-pair flag stays silent, exactly the gap the review found.
    for (const feeder of feeders) {
      expect(reputation.flags).not.toContain(`concentrated_counterparty:${feeder.did}`);
    }
    // The new group-level flag catches it: all 15 receipts are with
    // counterparties that have no standing outside this ring.
    expect(reputation.flags).toContain("unanchored_counterparty_volume");
    // Deliberately flag-only — trustScore/weight are untouched by this
    // check (see isAnchoredCounterparty's doc comment for why a weight cap
    // was tried and reverted).
    expect(reputation.trustScore).toBeGreaterThan(0);
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
      task: { capability: "translation.tr-en", specHash: `sha256:${createHash("sha256").update(`spec_${jobId}`).digest("hex")}`, createdAt: future },
      result: { outputHash: `sha256:${createHash("sha256").update(`out_${jobId}`).digest("hex")}`, completedAt: future },
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
      task: { capability: "translation.tr-en", specHash: `sha256:${createHash("sha256").update(`spec_${jobId}`).digest("hex")}`, createdAt: created },
      result: { outputHash: `sha256:${createHash("sha256").update(`out_${jobId}`).digest("hex")}`, completedAt: completedBeforeCreated },
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

  it("caps wash-trading: two fresh identities transacting only with each other never move trustScore", () => {
    // An independent review found 15 finalized receipts between two fresh,
    // otherwise-empty identities pushed trustScore 5.5 -> 21 with no
    // ceiling; concentrated_counterparty set correctly but nothing acted on
    // it. Both agents here only ever transact with each other -- their
    // "otherReceipts" (finalized receipts with any *other* counterparty) is
    // always 0, so every one of these receipts should be capped to zero
    // weight once the flag is live (>=3 finalized), and trustScore should
    // flatline rather than keep climbing.
    const attackerA = generateKeypair();
    const attackerB = generateKeypair();
    registerAgent(attackerA.did, { capabilities: ["job.posting", "x"] });
    registerAgent(attackerB.did, { capabilities: ["job.posting", "x"] });

    function washTrade(jobId: string) {
      const input = freshInput(jobId);
      const signature = signDraft(attackerA.did, attackerB.privateKey, attackerB.did, input);
      const draft = createDraft(attackerB.did, { ...input, agentAId: attackerA.did, signature });
      countersign(draft.receiptId, attackerA.did, signCountersign(draft, attackerA.privateKey));
    }

    for (let i = 0; i < 2; i++) washTrade(`wash_${i}`);
    const beforeFlag = computeReputation(attackerB.did);
    expect(beforeFlag.flags).not.toContain(`concentrated_counterparty:${attackerA.did}`); // <3 finalized, not flagged yet

    washTrade("wash_2"); // 3rd receipt: ratio 3/3 = 1.0 > 0.6, now flagged
    const atFlag = computeReputation(attackerB.did);
    expect(atFlag.flags).toContain(`concentrated_counterparty:${attackerA.did}`);
    expect(atFlag.trustScore).toBe(0); // otherReceipts = 0 -> cap = 0 -> zero weight

    for (let i = 3; i < 15; i++) washTrade(`wash_${i}`);
    const after15 = computeReputation(attackerB.did);
    expect(after15.components.rawReceipts).toBe(15); // receipts are still real, just unweighted
    expect(after15.trustScore).toBe(0); // still flat, not climbing toward 21

    // A legitimate, diversified counterparty gives the capped agent real
    // headroom: one receipt with someone else raises otherReceipts to 1, so
    // up to floor(1.5 * 1) = 1 of the wash-traded receipts can count again.
    const honest = generateKeypair();
    registerAgent(honest.did, { capabilities: ["job.posting"] });
    const input = freshInput("honest_job");
    const signature = signDraft(honest.did, attackerB.privateKey, attackerB.did, input);
    const draft = createDraft(attackerB.did, { ...input, agentAId: honest.did, signature });
    countersign(draft.receiptId, honest.did, signCountersign(draft, honest.privateKey));

    const withHonestHistory = computeReputation(attackerB.did);
    expect(withHonestHistory.trustScore).toBeGreaterThan(0);
  });
});
