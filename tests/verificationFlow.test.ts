import { describe, expect, it } from "vitest";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign, openDispute } from "../src/services/receiptService.js";
import { buildSignableVerificationContent, submitVerification, getVerification, listByReceipt } from "../src/services/verificationService.js";
import { computeReputation } from "../src/services/reputationService.js";
import { ApiError } from "../src/middleware/errors.js";
import type { CreateDraftInput } from "../src/services/receiptService.js";
import type { VerificationContentInput } from "../src/services/verificationService.js";

async function expectApiError(fn: () => unknown, code: string) {
  try {
    await fn();
    throw new Error(`expected ApiError ${code} but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

function finalizeReceipt(requester: ReturnType<typeof generateKeypair>, provider: ReturnType<typeof generateKeypair>, jobId: string) {
  const now = new Date().toISOString();
  const input: Omit<CreateDraftInput, "signature" | "agentAId"> = {
    jobId,
    task: { capability: "x", specHash: "sha256:spec", createdAt: now },
    result: { outputHash: "sha256:out", completedAt: now },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
  const content = buildSignableContent(requester.did, provider.did, input);
  const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
  const draft = createDraft(provider.did, { ...input, agentAId: requester.did, signature: draftSig });

  const counterContent = { ...draft, signatures: undefined, status: undefined, dispute: undefined };
  const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize(counterContent)), requester.privateKey));
  return countersign(draft.receiptId, requester.did, counterSig);
}

function signVerification(verifierKeys: ReturnType<typeof generateKeypair>, input: VerificationContentInput) {
  const content = buildSignableVerificationContent(input);
  const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), verifierKeys.privateKey));
  return { content, signature };
}

describe("independent verification (SPEC.md §12)", () => {
  it("verifies a finalized receipt and boosts the provider's reputation", () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });

    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);
    const before = computeReputation(provider.did);
    expect(before.components.attestedReceipts).toBe(0);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(verifier, input);
    const record = submitVerification(verifier.did, { ...input, signature });

    expect(record.verificationId).toMatch(/^sha256:/);
    expect(record.provider).toBe(provider.did);
    expect(getVerification(record.verificationId).result).toBe("verified");
    expect(listByReceipt(receipt.receiptId)).toHaveLength(1);

    const after = computeReputation(provider.did);
    expect(after.components.attestedReceipts).toBe(1);
    expect(after.trustScore).toBeGreaterThan(before.trustScore);
  });

  it("rejects self-verification", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: provider.did, // the provider trying to verify their own work
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(provider, input);
    await expectApiError(() => submitVerification(provider.did, { ...input, signature }), "SELF_VERIFICATION");
  });

  it("rejects the requester naming itself as verifier (not just the provider)", async () => {
    // An external audit found only the provider (agentB) was blocked from
    // self-verifying -- the requester (agentA), who already approved this
    // work by countersigning it, could name itself as the "independent"
    // verifier with no check at all.
    const requester = generateKeypair();
    const provider = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: requester.did, // the requester trying to "independently" verify a receipt it's already party to
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(requester, input);
    await expectApiError(() => submitVerification(requester.did, { ...input, signature }), "SELF_VERIFICATION");
  });

  it("rejects a verifier that isn't a registered agent", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const unregisteredVerifier = generateKeypair(); // deliberately never registered
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: unregisteredVerifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(unregisteredVerifier, input);
    await expectApiError(() => submitVerification(unregisteredVerifier.did, { ...input, signature }), "AGENT_NOT_FOUND");
  });

  it("rejects a second, different decision from a verifier who already decided this receipt", async () => {
    // Without this, the same verifier could submit "verified" and then,
    // separately, "rejected" (different content -> different
    // verificationId, so DUPLICATE_VERIFICATION's content-hash check
    // doesn't catch it) for the same receipt, leaving both as live records
    // with no way to tell which is authoritative.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const firstInput: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const first = signVerification(verifier, firstInput);
    submitVerification(verifier.did, { ...firstInput, signature: first.signature });

    const secondInput: VerificationContentInput = { ...firstInput, result: "rejected" };
    const second = signVerification(verifier, secondInput);
    await expectApiError(() => submitVerification(verifier.did, { ...secondInput, signature: second.signature }), "VERIFIER_ALREADY_DECIDED");
  });

  it("rejects verifying a receipt that is still a draft", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });

    const now = new Date().toISOString();
    const draftInput = {
      jobId: `job_${Math.random()}`,
      task: { capability: "x", specHash: "sha256:spec", createdAt: now },
      result: { outputHash: "sha256:out", completedAt: now },
      verification: { method: "payer_confirmation" as const, outcome: "success" as const },
    };
    const content = buildSignableContent(requester.did, provider.did, draftInput);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
    const draft = createDraft(provider.did, { ...draftInput, agentAId: requester.did, signature: draftSig });

    const input: VerificationContentInput = {
      receiptId: draft.receiptId,
      jobId: draft.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: draft.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(verifier, input);
    await expectApiError(() => submitVerification(verifier.did, { ...input, signature }), "RECEIPT_NOT_FINALIZED");
  });

  it("rejects an outputHash that doesn't match the receipt", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: "sha256:not_the_real_output",
      result: "verified",
    };
    const { signature } = signVerification(verifier, input);
    await expectApiError(() => submitVerification(verifier.did, { ...input, signature }), "VERIFICATION_TARGET_MISMATCH");
  });

  it("rejects a request not signed by the named verifier", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    const impostor = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    registerAgent(impostor.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(verifier, input);
    // impostor calls it, even though the content names `verifier` as the signer
    await expectApiError(() => submitVerification(impostor.did, { ...input, signature }), "NOT_VERIFIER");
  });

  it("rejects a forged signature", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    const impostor = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(impostor, input); // signed by the wrong key
    await expectApiError(() => submitVerification(verifier.did, { ...input, signature }), "INVALID_VERIFICATION_SIGNATURE");
  });

  it("rejects an unsupported method", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "tee_attestation" as unknown as "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified" as const,
    };
    const { signature } = signVerification(verifier, input);
    await expectApiError(() => submitVerification(verifier.did, { ...input, signature }), "UNSUPPORTED_VERIFICATION_METHOD");
  });

  it("rejects resubmitting byte-identical content", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(verifier, input);
    submitVerification(verifier.did, { ...input, signature });
    await expectApiError(() => submitVerification(verifier.did, { ...input, signature }), "DUPLICATE_VERIFICATION");
  });

  it("records a rejected verification without any reputation boost", () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "agent_attestation",
      outputHash: receipt.result.outputHash,
      result: "rejected",
    };
    const { signature } = signVerification(verifier, input);
    const record = submitVerification(verifier.did, { ...input, signature });
    expect(record.result).toBe("rejected");

    const reputation = computeReputation(provider.did);
    expect(reputation.components.attestedReceipts).toBe(0);
  });

  it("does not let a verified attestation resurrect a since-disputed receipt's reputation contribution", () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    const receipt = finalizeReceipt(requester, provider, `job_${Math.random()}`);

    const input: VerificationContentInput = {
      receiptId: receipt.receiptId,
      jobId: receipt.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    };
    const { signature } = signVerification(verifier, input);
    const record = submitVerification(verifier.did, { ...input, signature });

    const beforeDispute = computeReputation(provider.did);
    expect(beforeDispute.components.attestedReceipts).toBe(1);

    openDispute(receipt.receiptId, requester.did, "output did not match what was agreed");

    const afterDispute = computeReputation(provider.did);
    // The receipt is now disputed, so it's excluded from `finalized` entirely
    // (SPEC.md §4.3/§12.4) — attestedReceipts must drop back to 0, not stay
    // counted just because a Verification record still references it.
    expect(afterDispute.components.attestedReceipts).toBe(0);
    expect(afterDispute.flags).toContain("in_dispute");
    // The Verification record itself is untouched — still queryable evidence.
    expect(getVerification(record.verificationId).result).toBe("verified");
  });
});
