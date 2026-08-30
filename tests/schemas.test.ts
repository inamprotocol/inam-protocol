import { describe, expect, it } from "vitest";
import { draftReceiptSchema, postJobSchema } from "../sdk-js/src/core/schemas.js";

// SPEC.md v0.11 / audit: `settlement.amount` and `currency` (and a job's
// `budget`) were unchecked `z.string()` -- `"banana"` or a negative amount
// passed, then `Number("banana")` -> NaN poisoned the reputation volume sums.
const baseDraft = {
  jobId: "job_x",
  agentAId: "did:key:zRequester",
  task: { capability: "translation.tr-en", specHash: "sha256:spec", createdAt: "2026-08-21T09:14:00Z" },
  result: { outputHash: "sha256:out", completedAt: "2026-08-21T09:41:00Z" },
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
    expect(postJobSchema.safeParse({ capability: "x", specHash: "sha256:s", budget: { amount: "10.00", currency: "EUR" } }).success).toBe(true);
    expect(postJobSchema.safeParse({ capability: "x", specHash: "sha256:s", budget: { amount: "ten" } }).success).toBe(false);
  });
});
