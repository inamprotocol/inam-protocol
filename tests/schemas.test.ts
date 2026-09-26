import { describe, expect, it } from "vitest";
import { draftReceiptSchema, postJobSchema, submitVerificationSchema } from "../sdk-js/src/core/schemas.js";

// SPEC.md v0.11 / audit: `settlement.amount` and `currency` (and a job's
// `budget`) were unchecked `z.string()` -- `"banana"` or a negative amount
// passed, then `Number("banana")` -> NaN poisoned the reputation volume sums.
const baseDraft = {
  jobId: "job_x",
  agentAId: "did:key:zRequester",
  task: { capability: "translation.tr-en", specHash: "sha256:d4f02eaafd1a9e9de7d10972ca8e47fa7a985825c3c9c1e249c72683cb3e4f19", createdAt: "2026-08-21T09:14:00Z" },
  result: { outputHash: "sha256:762069bc07a6e1b5df123a5ae7bd91c10daa04694fbaa17fba0cd6a8dcce8f22", completedAt: "2026-08-21T09:41:00Z" },
  verification: { method: "payer_confirmation" as const, outcome: "success" as const },
  signature: "base64sig",
};

describe("money-field validation", () => {
  it("accepts a well-formed settlement", () => {
    const r = draftReceiptSchema.safeParse({ ...baseDraft, settlement: { amount: "12.50", currency: "USDC" } });
    expect(r.success).toBe(true);
  });

  it("rejects a non-numeric settlement amount", () => {
    const r = draftReceiptSchema.safeParse({ ...baseDraft, settlement: { amount: "banana", currency: "USD" } });
    expect(r.success).toBe(false);
  });

  it("rejects a negative settlement amount", () => {
    const r = draftReceiptSchema.safeParse({ ...baseDraft, settlement: { amount: "-5.00", currency: "USD" } });
    expect(r.success).toBe(false);
  });

  it("rejects a free-form currency string", () => {
    const r = draftReceiptSchema.safeParse({ ...baseDraft, settlement: { amount: "1.00", currency: "US Dollars!" } });
    expect(r.success).toBe(false);
  });

  it("applies the same rules to a job budget", () => {
    expect(postJobSchema.safeParse({ capability: "x", specHash: "sha256:043a718774c572bd8a25adbeb1bfcd5c0256ae11cecf9f9c3f925d0e52beaf89", budget: { amount: "10.00", currency: "EUR" } }).success).toBe(true);
    expect(postJobSchema.safeParse({ capability: "x", specHash: "sha256:043a718774c572bd8a25adbeb1bfcd5c0256ae11cecf9f9c3f925d0e52beaf89", budget: { amount: "ten" } }).success).toBe(false);
  });
});

// SPEC.md v0.32: an external test found live receipts whose hashes were
// labels ("sha256:review_notes_v1"), not content hashes anyone could check.
describe("content-hash validation", () => {
  const bad = ["sha256:review_notes_v1", "sha256:out", "sha256:" + "A".repeat(64), "md5:" + "0".repeat(64), "sha256:" + "0".repeat(63)];
  it.each(bad)("rejects %s as a spec/output hash", (h) => {
    expect(draftReceiptSchema.safeParse({ ...baseDraft, result: { ...baseDraft.result, outputHash: h } }).success).toBe(false);
    expect(draftReceiptSchema.safeParse({ ...baseDraft, task: { ...baseDraft.task, specHash: h } }).success).toBe(false);
    expect(postJobSchema.safeParse({ capability: "x", specHash: h }).success).toBe(false);
    expect(submitVerificationSchema.safeParse({ receiptId: "r", verifier: "v", method: "deterministic", outputHash: h, result: "verified", signature: "s" }).success).toBe(false);
  });
  it("accepts a real sha256 content hash", () => {
    expect(draftReceiptSchema.safeParse(baseDraft).success).toBe(true);
  });
});
