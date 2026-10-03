import { describe, it, expect } from "vitest";
import { checkTrust, decideTrust } from "../sdk-js/src/trust.js";
import type { InamClient } from "../sdk-js/src/client.js";
import type { AgentRecord, ReputationResult } from "../sdk-js/src/types.js";

// Allow / escrow / deny from the registry's appraisal, decided client-side (SPEC.md §5.4).
const DID = "did:key:z6MkagentEXAMPLE";
const agent = (revokedAt?: string) => ({ id: DID, linked: {}, revokedAt }) as unknown as AgentRecord;
const rep = (o: Partial<ReputationResult> = {}) => ({ trustScore: 40, evidenceLevel: "countersigned", flags: [], ...o }) as ReputationResult;

describe("decideTrust", () => {
  it("allows independently verified history by default, with a reason", () => {
    const d = decideTrust(agent(), rep({ evidenceLevel: "independently_verified" }));
    expect(d.decision).toBe("allow");
    expect(d.reasons[0]).toMatch(/independently_verified, trustScore 40/);
  });

  it("escrows countersigned-only history by default, allows it if the caller lowers the bar", () => {
    expect(decideTrust(agent(), rep())).toMatchObject({ decision: "escrow", reasons: ["evidence countersigned is below independently_verified"] });
    expect(decideTrust(agent(), rep(), { allow: { minEvidence: "countersigned" } }).decision).toBe("allow");
  });

  it("escrows an agent with no history instead of denying it", () => {
    expect(decideTrust(agent(), rep({ evidenceLevel: "none", trustScore: 0 }))).toMatchObject({ decision: "escrow", reasons: ["evidence none is below independently_verified"] });
  });

  it("caps at escrow on a warning flag, including suffixed ones", () => {
    const d = decideTrust(agent(), rep({ evidenceLevel: "independently_verified", flags: ["in_dispute", "concentrated_counterparty:did:key:z6Mkother"] }));
    expect(d.decision).toBe("escrow");
    expect(d.reasons).toEqual(["flag in_dispute", "flag concentrated_counterparty:did:key:z6Mkother"]);
    expect(decideTrust(agent(), rep({ evidenceLevel: "independently_verified", flags: ["in_dispute"] }), { escrowFlags: [] }).decision).toBe("allow");
  });

  it("denies below the escrow bar and on revocation", () => {
    expect(decideTrust(agent(), rep({ trustScore: 5 }), { escrow: { minTrustScore: 10 } })).toMatchObject({ decision: "deny", reasons: ["trustScore 5 is below 10"] });
    expect(decideTrust(agent("2026-10-01T00:00:00Z"), rep()).decision).toBe("deny");
  });

  it("applies a stricter allow bar", () => {
    const d = decideTrust(agent(), rep(), { allow: { minEvidence: "independently_verified", minTrustScore: 50 } });
    expect(d).toMatchObject({ decision: "escrow", reasons: ["evidence countersigned is below independently_verified"] });
  });
});

describe("checkTrust", () => {
  it("denies an ID the registry doesn't know", async () => {
    const inam = { getAgent: () => Promise.reject(new Error("404")), getReputation: () => Promise.reject(new Error("404")) } as unknown as InamClient;
    expect(await checkTrust(DID, inam)).toMatchObject({ decision: "deny", reasons: ["INAM ID not found in the registry"] });
  });

  it("fetches and decides", async () => {
    const inam = { getAgent: async () => agent(), getReputation: async () => rep() } as unknown as InamClient;
    expect((await checkTrust(DID, inam)).decision).toBe("escrow");
  });
});
