import { describe, expect, it } from "vitest";
import { agents, receipts, explainQueryPlan, migrateDraftWindowToNull } from "../src/storage/db.js";
import type { AgentRecord, ExecutionReceipt } from "../src/types.js";

function makeAgent(id: string, capabilities: string[]): AgentRecord {
  return {
    id,
    capabilities,
    metadata: {},
    linked: {},
    linkedProof: {},
    stakeUsd: 0,
    createdAt: new Date().toISOString(),
    isAuthorizedVerifier: false,
  };
}

function makeReceipt(id: string, agentAId: string, agentBId: string): ExecutionReceipt {
  return {
    receiptVersion: "1.0",
    receiptId: id,
    jobId: `job_${id}`,
    agentA: { id: agentAId, role: "requester" },
    agentB: { id: agentBId, role: "worker" },
    task: { capability: "translate", specHash: "hash", createdAt: new Date().toISOString() },
    result: { outputHash: "out", completedAt: new Date().toISOString() },
    verification: { method: "payer_confirmation", outcome: "success" },
    dispute: { status: "none", windowClosesAt: new Date().toISOString() },
    signatures: {},
    status: "finalized",
  };
}

describe("storage query indexing", () => {
  it("agents.search returns only agents with the queried capability, using the capability index", () => {
    for (let i = 0; i < 50; i++) {
      agents.set(`did:key:agent-${i}`, makeAgent(`did:key:agent-${i}`, [i % 5 === 0 ? "translate" : "review"]));
    }

    const found = agents.search({ capability: "translate" });
    expect(found.length).toBe(10);
    expect(found.every((a) => a.capabilities.includes("translate"))).toBe(true);

    const plan = explainQueryPlan(
      "SELECT a.data FROM agents a JOIN agent_capabilities c ON c.agent_id = a.id WHERE c.capability = 'translate' AND a.revoked = 0",
    );
    expect(plan).not.toMatch(/SCAN/);
    expect(plan).toMatch(/USING INDEX/);
  });

  it("receipts.listByAgent returns only receipts where the agent is a party, using the agent indexes", () => {
    for (let i = 0; i < 30; i++) {
      receipts.set(`rcpt-${i}`, makeReceipt(`rcpt-${i}`, "did:key:party-a", `did:key:other-${i}`));
    }
    receipts.set("rcpt-unrelated", makeReceipt("rcpt-unrelated", "did:key:x", "did:key:y"));

    const found = receipts.listByAgent("did:key:party-a");
    expect(found.length).toBe(30);
    expect(found.every((r) => r.agentA.id === "did:key:party-a")).toBe(true);

    const plan = explainQueryPlan("SELECT data FROM receipts WHERE agent_a_id = 'did:key:party-a' OR agent_b_id = 'did:key:party-a'");
    expect(plan).not.toMatch(/SCAN/);
    expect(plan).toMatch(/USING INDEX/);
  });

  it("migrateDraftWindowToNull rewrites legacy \"\" draft windows to null and leaves real dates alone", () => {
    const legacy = makeReceipt("rcpt-legacy-draft", "did:key:m-a", "did:key:m-b");
    receipts.set(legacy.receiptId, { ...legacy, status: "draft", dispute: { status: "none", windowClosesAt: "" as unknown as null } });
    const dated = makeReceipt("rcpt-dated", "did:key:m-a", "did:key:m-b");
    receipts.set(dated.receiptId, dated);

    migrateDraftWindowToNull();
    migrateDraftWindowToNull(); // idempotent

    expect(receipts.get("rcpt-legacy-draft")!.dispute.windowClosesAt).toBeNull();
    expect(receipts.get("rcpt-dated")!.dispute.windowClosesAt).toBe(dated.dispute.windowClosesAt);
  });
});
