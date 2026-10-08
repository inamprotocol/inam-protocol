import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildVectors, VECTORS_PATH } from "../scripts/x402-context-vectors.js";

// Published vectors for x402 #1777: the committed file must match the code, and the
// hash and decision must be recomputable from policy_input alone, without the SDK.
const RANK: Record<string, number> = { none: 0, countersigned: 1, independently_verified: 2 };
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

describe("x402 CounterpartyContext vectors", () => {
  const file = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

  it("committed vectors match the generator", () => {
    expect(file).toEqual(JSON.parse(JSON.stringify(buildVectors())));
  });

  for (const v of file.vectors) {
    it(`recomputes independently: ${v.name}`, () => {
      expect(v.policy_input_canonical).toBe(JSON.stringify(sortKeys(v.policy_input)));
      expect(v.context.policy_input_hash).toBe(`sha256:${createHash("sha256").update(v.policy_input_canonical, "utf8").digest("hex")}`);
      const i = v.policy_input;
      const allow = !i.revoked && i.pay_to.includes(i.bound_wallet) && RANK[i.evidence_level] >= RANK[i.policy.minEvidence] && i.trust_score >= i.policy.minTrustScore;
      expect(v.context.decision).toBe(allow ? "allow" : "deny");
      expect(v.name.startsWith(v.context.decision)).toBe(true);
    });
  }
});
