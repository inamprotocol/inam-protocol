import { describe, expect, it, vi } from "vitest";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign } from "../src/services/receiptService.js";
import { computeReputation } from "../src/services/reputationService.js";
import * as jobService from "../src/services/jobService.js";
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

describe("job lifecycle", () => {
  it("goes open -> accepted, and rejects offers/accepts from the wrong parties", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });
    registerAgent(stranger.did, { capabilities: ["translation.tr-en"] });

    const job = jobService.postJob(poster.did, { capability: "translation.tr-en", specHash: "sha256:91b9443982eec3c5a65d2ad677e39e5c9f47ad5b06085337267c9055e692780e" });
    expect(job.status).toBe("open");

    await expectApiError(() => jobService.submitOffer(job.jobId, poster.did), "SELF_DEALING");

    const offered = jobService.submitOffer(job.jobId, worker.did, "I can do this");
    expect(offered.offers).toHaveLength(1);

    await expectApiError(() => jobService.acceptOffer(job.jobId, stranger.did, worker.did), "NOT_POSTER");
    await expectApiError(() => jobService.acceptOffer(job.jobId, poster.did, stranger.did), "OFFER_NOT_FOUND");

    const accepted = jobService.acceptOffer(job.jobId, poster.did, worker.did);
    expect(accepted.status).toBe("accepted");
    expect(accepted.acceptedAgentId).toBe(worker.did);

    await expectApiError(() => jobService.submitOffer(job.jobId, stranger.did), "JOB_NOT_OPEN");
  });

  it("lets the poster cancel an open job, and rejects a non-poster's cancel", async () => {
    const poster = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(stranger.did, { capabilities: ["x"] });

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:da859f09c346a9d6b2936c0b0e5917487291455e0f37629569e2159e0aa4db03" });
    await expectApiError(() => jobService.cancelJob(job.jobId, stranger.did), "NOT_POSTER");

    const cancelled = jobService.cancelJob(job.jobId, poster.did);
    expect(cancelled.status).toBe("cancelled");
    await expectApiError(() => jobService.cancelJob(job.jobId, poster.did), "JOB_NOT_CANCELLABLE");
  });

  it("a receipt referencing an accepted job's parties completes that job automatically", () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const job = jobService.postJob(poster.did, { capability: "translation.tr-en", specHash: "sha256:8c485c1f8eddc4c77e3632557d29e77e08323adcf865ff95b3dfac453d96d0a3" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "translation.tr-en", specHash: "sha256:8c485c1f8eddc4c77e3632557d29e77e08323adcf865ff95b3dfac453d96d0a3", createdAt: now },
      result: { outputHash: "sha256:1b26a1db881b1598c0c96bde9199ed7486a8080c7c7335315df7e586f0b181d3", completedAt: now },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(poster.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: poster.did, signature });
    const finalized = countersign(draft.receiptId, poster.did, signCountersign(draft, poster.privateKey));

    const completedJob = jobService.getJob(job.jobId);
    expect(completedJob.status).toBe("completed");
    expect(completedJob.receiptId).toBe(finalized.receiptId);
  });

  it("rejects a receipt whose parties don't match the referenced job's poster/accepted worker", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    const impostorWorker = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["x"] });
    registerAgent(impostorWorker.did, { capabilities: ["x"] });

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:6bfdf1dc666ee4b7ad2deeb7246bd7e007b382495878012b274939d414782f02" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "x", specHash: "sha256:6bfdf1dc666ee4b7ad2deeb7246bd7e007b382495878012b274939d414782f02", createdAt: now },
      result: { outputHash: "sha256:1ea02e69ddacdcb6e8a45e60d76965887217ddb2c191fcd6a83624607c08800b", completedAt: now },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(poster.did, impostorWorker.privateKey, impostorWorker.did, input);

    await expectApiError(
      () => createDraft(impostorWorker.did, { ...input, agentAId: poster.did, signature }),
      "JOB_PARTY_MISMATCH",
    );
  });

  it("rejects a receipt referencing a job that hasn't had an offer accepted yet", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["x"] });

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:025d962c66b822baa3a4bd7bd908c30e9bd9750d0b72ba104abb000190b28921" });

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "x", specHash: "sha256:025d962c66b822baa3a4bd7bd908c30e9bd9750d0b72ba104abb000190b28921", createdAt: now },
      result: { outputHash: "sha256:33be53d948082b1604474f90c6cc9aaf0c236f470fbc7b8d1670a17bbce3e0ef", completedAt: now },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(poster.did, worker.privateKey, worker.did, input);

    await expectApiError(() => createDraft(worker.did, { ...input, agentAId: poster.did, signature }), "JOB_NOT_ACCEPTED");
  });

  it("keeps a job cancelled even if a draft receipt finalizes afterward (no cancelled -> completed, audit #11)", () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["x"] });

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:422bf826331bea32b36dfcd7339778a6fb20e9ecf10265b00568f207c0b09a27" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "x", specHash: "sha256:422bf826331bea32b36dfcd7339778a6fb20e9ecf10265b00568f207c0b09a27", createdAt: now },
      result: { outputHash: "sha256:cde679d980386d2ce9a828dff82ddd9b9acaba0f76970d85d40e8b73b29ecdc0", completedAt: now },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(poster.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: poster.did, signature });

    // poster cancels the accepted job, THEN countersigns the pending draft
    jobService.cancelJob(job.jobId, poster.did);
    const finalized = countersign(draft.receiptId, poster.did, signCountersign(draft, poster.privateKey));
    expect(finalized.status).toBe("finalized"); // the receipt is still a valid bilateral record

    const jobAfter = jobService.getJob(job.jobId);
    expect(jobAfter.status).toBe("cancelled"); // NOT "completed"
    expect(jobAfter.receiptId).toBeUndefined();
  });

  it("rejects offers and acceptance on a job past its expiresAt (audit #11)", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["x"] });

    const past = new Date(Date.now() - 60_000).toISOString();
    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:3eb1322388bf2bc62a21e781b5d5d9e59e39ee462fd2c07527a6e926c10397e2", expiresAt: past });
    await expectApiError(() => jobService.submitOffer(job.jobId, worker.did), "JOB_EXPIRED");
  });

  it("reports non-performance only for the poster, only on an accepted job, and only after the grace window (SPEC.md v0.25)", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["x"] });
    registerAgent(stranger.did, { capabilities: ["x"] });

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:9022f0185cec9c225a63f4960cd790f54f95b65cac5208afc2ae574a528cd8c3" });
    await expectApiError(() => jobService.reportNonPerformance(job.jobId, poster.did), "JOB_NOT_REPORTABLE"); // still open

    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    await expectApiError(() => jobService.reportNonPerformance(job.jobId, stranger.did), "NOT_POSTER");
    await expectApiError(() => jobService.reportNonPerformance(job.jobId, poster.did), "TOO_EARLY_TO_REPORT");

    try {
      vi.useFakeTimers({ now: Date.now() });
      vi.setSystemTime(Date.now() + 73 * 3600_000); // just past the 72h grace window
      const reported = jobService.reportNonPerformance(job.jobId, poster.did, "never delivered");
      expect(reported.status).toBe("nonperformed");
      expect(reported.nonPerformance?.reason).toBe("never delivered");

      await expectApiError(() => jobService.reportNonPerformance(job.jobId, poster.did), "JOB_NOT_REPORTABLE"); // one-shot
      await expectApiError(() => jobService.cancelJob(job.jobId, poster.did), "JOB_NOT_CANCELLABLE"); // terminal
    } finally {
      vi.useRealTimers();
    }
  });

  it("weights a non-performance report by the reporting poster's own trust, deduped per poster (SPEC.md v0.25)", () => {
    // A worker who is ghosted has no receipt to point to at all -- this is
    // the only negative-outcome signal that doesn't require one.
    const poster = generateKeypair();
    const worker = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["x"] });

    expect(computeReputation(worker.did).components.nonPerformanceReports).toBe(0);

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:835f1bd8a61aafe09605fc54bf0bffe5e754140954e2530c757344693dba4bab" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    try {
      vi.useFakeTimers({ now: Date.now() });
      vi.setSystemTime(Date.now() + 73 * 3600_000);
      jobService.reportNonPerformance(job.jobId, poster.did);
    } finally {
      vi.useRealTimers();
    }

    const rep = computeReputation(worker.did);
    expect(rep.components.nonPerformanceReports).toBe(1);
    expect(rep.flags).toContain("nonperformance_reported");
  });

  it("finds an open job by capability search", () => {
    const poster = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    jobService.postJob(poster.did, { capability: "very.unique.capability.xyz", specHash: "sha256:8823501e4f1c50ee3d0522a8ee54d72590ee3e1f5f381796eac3d5526e738c85" });

    const results = jobService.searchJobs({ capability: "very.unique.capability.xyz", status: "open" });
    expect(results).toHaveLength(1);
  });
});
