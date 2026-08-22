import { describe, expect, it } from "vitest";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign } from "../src/services/receiptService.js";
import * as jobService from "../src/services/jobService.js";
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

describe("job lifecycle", () => {
  it("goes open -> accepted, and rejects offers/accepts from the wrong parties", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });
    registerAgent(stranger.did, { capabilities: ["translation.tr-en"] });

    const job = jobService.postJob(poster.did, { capability: "translation.tr-en", specHash: "sha256:spec_1" });
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

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:spec_2" });
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

    const job = jobService.postJob(poster.did, { capability: "translation.tr-en", specHash: "sha256:spec_3" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "translation.tr-en", specHash: "sha256:spec_3", createdAt: now },
      result: { outputHash: "sha256:out_3", completedAt: now },
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

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:spec_4" });
    jobService.submitOffer(job.jobId, worker.did);
    jobService.acceptOffer(job.jobId, poster.did, worker.did);

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "x", specHash: "sha256:spec_4", createdAt: now },
      result: { outputHash: "sha256:out_4", completedAt: now },
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

    const job = jobService.postJob(poster.did, { capability: "x", specHash: "sha256:spec_5" });

    const now = new Date().toISOString();
    const input = {
      jobId: job.jobId,
      task: { capability: "x", specHash: "sha256:spec_5", createdAt: now },
      result: { outputHash: "sha256:out_5", completedAt: now },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const signature = signDraft(poster.did, worker.privateKey, worker.did, input);

    await expectApiError(() => createDraft(worker.did, { ...input, agentAId: poster.did, signature }), "JOB_NOT_ACCEPTED");
  });

  it("finds an open job by capability search", () => {
    const poster = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    jobService.postJob(poster.did, { capability: "very.unique.capability.xyz", specHash: "sha256:spec_6" });

    const results = jobService.searchJobs({ capability: "very.unique.capability.xyz", status: "open" });
    expect(results).toHaveLength(1);
  });
});
