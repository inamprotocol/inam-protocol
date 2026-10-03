import { describe, it, expect } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { buildErc8004Feedback, verifyErc8004Feedback, INAM_FEEDBACK_TAG } from "../sdk-js/src/erc8004.js";
import { buildSignableContent } from "../sdk-js/src/core/receiptContent.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { generateKeypair, sign, toBase64, toHex } from "../sdk-js/src/crypto/keys.js";
import type { InamClient } from "../sdk-js/src/client.js";
import type { AgentRecord, ExecutionReceipt } from "../sdk-js/src/types.js";

// SPEC.md §11.1: an INAM receipt backing ERC-8004 feedback.
const requesterKey = generateKeypair();
const providerKey = generateKeypair();
const CLIENT = "0x1111111111111111111111111111111111111111";
const PROVIDER_ADDR = "0x2222222222222222222222222222222222222222";
const target = { agentRegistry: "eip155:8453:0x8004000000000000000000000000000000000000", agentId: 7 };

function signedReceipt(outcome: "success" | "failed" = "success"): ExecutionReceipt {
  const content = buildSignableContent(requesterKey.did, providerKey.did, {
    jobId: "job_1",
    task: { capability: "translation.tr-en", specHash: `sha256:${"a".repeat(64)}`, createdAt: "2026-10-01T10:00:00.000Z" },
    result: { outputHash: `sha256:${"b".repeat(64)}`, completedAt: "2026-10-01T10:05:00.000Z" },
    verification: { method: "payer_confirmation", outcome },
  });
  const bytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  return {
    ...content,
    dispute: { status: "none", windowClosesAt: "2026-10-04T10:05:00.000Z" },
    signatures: { agentB: toBase64(sign(bytes, providerKey.privateKey)), agentA: toBase64(sign(bytes, requesterKey.privateKey)) },
    status: "finalized",
    visibility: "public",
  } as ExecutionReceipt;
}

const agent = (id: string, addr?: string) => ({ id, linked: addr ? { erc8004_id: addr } : {} }) as unknown as AgentRecord;
const registry = (receipt: ExecutionReceipt, requesterAddr = CLIENT) =>
  ({
    getAgent: async (id: string) => (id === requesterKey.did ? agent(id, requesterAddr) : agent(id, PROVIDER_ADDR)),
    getReceipt: async () => receipt,
  }) as unknown as InamClient;

describe("ERC-8004 feedback from INAM receipts (SPEC.md §11.1)", () => {
  it("builds giveFeedback args whose hash commits to the file", () => {
    const fb = buildErc8004Feedback(signedReceipt(), agent(requesterKey.did, CLIENT), target, "2026-10-03T00:00:00.000Z");
    expect(fb.args).toMatchObject({ agentId: 7, value: 100, valueDecimals: 0, tag1: INAM_FEEDBACK_TAG, tag2: "translation.tr-en" });
    expect(fb.feedbackHash).toBe(`0x${toHex(keccak_256(new TextEncoder().encode(fb.fileText)))}`);
    const file = JSON.parse(fb.fileText);
    expect(file.clientAddress).toBe(`eip155:8453:${CLIENT}`);
    expect(file.inam.receipt.status).toBeUndefined();
  });

  it("refuses drafts, participants_only receipts, and requesters with no linked address", () => {
    const r = signedReceipt();
    expect(() => buildErc8004Feedback({ ...r, status: "draft" }, agent(requesterKey.did, CLIENT), target)).toThrow(/finalized/);
    expect(() => buildErc8004Feedback({ ...r, visibility: "participants_only" }, agent(requesterKey.did, CLIENT), target)).toThrow(/participants_only/);
    expect(() => buildErc8004Feedback(r, agent(requesterKey.did), target)).toThrow(/erc8004_id/);
  });

  it("verifies genuine feedback and reports the provider's address", async () => {
    const r = signedReceipt();
    const fb = buildErc8004Feedback(r, agent(requesterKey.did, CLIENT), target);
    const check = await verifyErc8004Feedback(fb.fileText, { feedbackHash: fb.feedbackHash, clientAddress: CLIENT, value: 100 }, registry(r));
    expect(check).toMatchObject({ valid: true, reasons: [], receiptId: r.receiptId, providerDid: providerKey.did, providerAddress: PROVIDER_ADDR });
  });

  it("rejects a sender that isn't the requester, a tampered file, a wrong value, and a disputed receipt", async () => {
    const r = signedReceipt();
    const fb = buildErc8004Feedback(r, agent(requesterKey.did, CLIENT), target);
    const other = "0x3333333333333333333333333333333333333333";
    const sybil = await verifyErc8004Feedback(fb.fileText, { feedbackHash: fb.feedbackHash, clientAddress: other }, registry(r));
    expect(sybil.reasons).toEqual(expect.arrayContaining(["feedback was not sent from the requester's proven erc8004_id"]));

    const forged = fb.fileText.replace('"outcome":"success"', '"outcome":"failed"');
    const tampered = await verifyErc8004Feedback(forged, { feedbackHash: fb.feedbackHash, clientAddress: CLIENT }, registry(r));
    expect(tampered.reasons).toEqual(expect.arrayContaining(["feedbackHash does not match the file", "receiptId does not match the receipt content"]));

    const wrongValue = await verifyErc8004Feedback(fb.fileText, { feedbackHash: fb.feedbackHash, clientAddress: CLIENT, value: 0 }, registry(r));
    expect(wrongValue.reasons).toEqual(["value 0 does not match receipt outcome success"]);

    const disputed = await verifyErc8004Feedback(fb.fileText, { feedbackHash: fb.feedbackHash, clientAddress: CLIENT }, registry({ ...r, status: "disputed" }));
    expect(disputed.reasons).toEqual(["receipt is disputed in the registry"]);
  });
});
