import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { keypairFromPrivateKey, toHex } from "../sdk-js/src/index.js";
import { registerAgent } from "../src/services/agentService.js";
import { createDraft, countersign as registryCountersign } from "../src/services/receiptService.js";
import { computeReputation } from "../src/services/reputationService.js";
import { countersign, draftFromAgentReceipt, verifyAgentReceipt, testKey, SAMPLE_JOB, type AgentReceiptsSample } from "../examples/agent-receipts-adapter.js";

const sample: AgentReceiptsSample = JSON.parse(readFileSync(new URL("../examples/agent-receipts-sample.json", import.meta.url), "utf8"));
const workerKey = toHex(testKey("agent-receipts worker"));
const requester = keypairFromPrivateKey(testKey("agent-receipts requester"));

describe("examples/agent-receipts-adapter", () => {
  it("verifies the Agent Receipts signature and refuses a tampered receipt", () => {
    expect(verifyAgentReceipt(sample)).toBe(true);
    const tampered = { ...sample, receipt: { ...sample.receipt, action: "other_action" } };
    expect(verifyAgentReceipt(tampered)).toBe(false);
    expect(() => draftFromAgentReceipt(tampered, workerKey, requester.did)).toThrow(/does not verify/);
  });

  it("maps fields, and the reference registry accepts the draft and the countersign", () => {
    const draft = draftFromAgentReceipt(sample, workerKey, requester.did);
    expect(draft.task).toEqual({ capability: "summarize_text", specHash: sample.receipt.input_hash, createdAt: sample.receipt.timestamp });
    expect(draft.result.outputHash).toBe(sample.receipt.output_hash);
    expect(draft.settlement).toBeUndefined(); // cost_usd is spend, not payment

    registerAgent(draft.agentB.id, { capabilities: ["summarize_text"] });
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    const { signatures, status, receiptVersion, receiptId, agentA, agentB, dispute, ...content } = draft;
    const stored = createDraft(agentB.id, { ...content, agentAId: agentA.id, signature: signatures.agentB });
    expect(stored.receiptId).toBe(receiptId);
    // A single-party receipt is provenance only.
    expect(computeReputation(agentB.id).components.verifiedReceipts).toBe(0);

    const final = countersign(draft, requester, SAMPLE_JOB);
    expect(registryCountersign(receiptId, requester.did, final.signatures.agentA).status).toBe("finalized");
    expect(computeReputation(agentB.id).components.verifiedReceipts).toBe(1);
  });

  it("requester refuses to countersign output it did not receive", () => {
    const draft = draftFromAgentReceipt(sample, workerKey, requester.did);
    expect(() => countersign(draft, requester, { ...SAMPLE_JOB, output: { summary: "something else" } })).toThrow(/not countersigning/);
  });

  it("refuses a worker key other than the one that signed the Agent Receipts receipt", () => {
    expect(() => draftFromAgentReceipt(sample, toHex(testKey("someone else")), requester.did)).toThrow(/not the key/);
  });
});
