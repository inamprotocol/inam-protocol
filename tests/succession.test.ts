import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { InamClient } from "../sdk-js/src/client.js";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { successionSigningBytes, verifySuccession } from "../sdk-js/src/core/succession.js";
import type { ReputationResult, SuccessionRecord } from "../sdk-js/src/index.js";

// SPEC.md §2.3 (v0.42): key succession against the Node reference server.
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer().listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const hash = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const client = () => new InamClient(baseUrl, generateKeypair());
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

/** worker drafts, requester countersigns: one finalized receipt. */
async function finalizedReceipt(worker: InamClient, requester: InamClient) {
  const jobId = `job_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const draft = await worker.submitWork(requester.did, {
    jobId,
    task: { capability: "translation.tr-en", specHash: hash(`spec ${jobId}`), createdAt: now },
    result: { outputHash: hash(`out ${jobId}`), completedAt: now },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  return requester.acceptWork(draft);
}

describe("key succession (SPEC.md §2.3)", () => {
  it("hands the identity and its receipts to a fresh key, retires the old one, and logs it", async () => {
    const old = client();
    const peer = client();
    await old.registerAgent(["translation.tr-en"], { name: "worker" });
    await peer.registerAgent(["job.posting"]);
    const receipt = await finalizedReceipt(old, peer);
    const before = await old.getReputation(old.did);

    const nextKeys = generateKeypair();
    const res = await old.succeed(nextKeys);
    expect(res.predecessor.succeededBy).toBe(nextKeys.did);
    expect(res.successor.succession?.predecessor).toBe(old.did);
    expect(verifySuccession(res.successor.succession!)).toBe(true);
    expect(res.successor.capabilities).toEqual(["translation.tr-en"]);
    expect(res.successor.linked).toEqual({});
    expect(res.successor.isAuthorizedVerifier).toBe(false);

    // the old key signs nothing further, including a second succession
    expect(await errCode(old.succeed(generateKeypair()))).toMatch(/AGENT_SUCCEEDED/);
    expect(await errCode(old.revoke("too late"))).toMatch(/AGENT_SUCCEEDED/);

    // the successor carries the history; the predecessor is marked
    const next = new InamClient(baseUrl, nextKeys);
    const rep = (await next.getReputation(nextKeys.did)) as ReputationResult;
    expect(rep.components.finalizedReceipts).toBe(1);
    expect(rep.trustScore).toBe(before.trustScore);
    expect(rep.flags).toContain(`inherited_from:${old.did}`);
    expect((await old.getReputation(old.did)).flags).toContain(`succeeded:${nextKeys.did}`);

    // disputes follow: the counterparty disputes the predecessor's receipt, the successor is flagged
    await peer.disputeReceipt(receipt.receiptId, "output was wrong");
    expect((await next.getReputation(nextKeys.did)).flags).toContain("in_dispute");

    // append-only log entry with the signed statement as payload
    const { entries } = (await (await fetch(`${baseUrl}/v1/transparency/entries?limit=200`)).json()) as {
      entries: Array<{ entryType: string; refId: string; payload: string | null }>;
    };
    const entry = entries.find((e) => e.entryType === "agent_succeeded" && e.refId === old.did)!;
    expect(verifySuccession(JSON.parse(entry.payload!) as SuccessionRecord)).toBe(true);

    // out of search by default
    const search = (await (await fetch(`${baseUrl}/v1/agents/search?capability=translation.tr-en`)).json()) as { agents: { id: string }[] };
    expect(search.agents.map((a) => a.id)).toContain(nextKeys.did);
    expect(search.agents.map((a) => a.id)).not.toContain(old.did);

    // the successor is an ordinary agent and can itself be succeeded
    const third = generateKeypair();
    await next.succeed(third);
    const rep3 = await new InamClient(baseUrl, third).getReputation(third.did);
    expect(rep3.components.rawReceipts).toBe(1);
    expect(rep3.flags).toEqual(expect.arrayContaining([`inherited_from:${old.did}`, `inherited_from:${nextKeys.did}`]));
  });

  it("refuses an already-registered successor (no merging two histories)", async () => {
    const a = client();
    const b = client();
    await a.registerAgent(["x"]);
    await b.registerAgent(["x"]);
    expect(await errCode(a.succeed((b as unknown as { keypair: ReturnType<typeof generateKeypair> }).keypair))).toMatch(/AGENT_ALREADY_REGISTERED/);
  });

  it("refuses a statement the successor key did not sign, a revoked predecessor, and someone else's ID", async () => {
    const a = client();
    await a.registerAgent(["x"]);
    const target = generateKeypair();
    const forged = generateKeypair();
    const bytes = successionSigningBytes(a.did, target.did);
    const path = `/v1/agents/${encodeURIComponent(a.did)}/succeed`;
    const body = { successor: target.did, predecessorSignature: toBase64(sign(bytes, (a as any).keypair.privateKey)), successorSignature: toBase64(sign(bytes, forged.privateKey)) };
    expect(await errCode((a as any).request("POST", path, body, { idempotencyKey: "forged" }))).toMatch(/SUCCESSION_INVALID/);

    const other = client();
    await other.registerAgent(["x"]);
    expect(await errCode((other as any).request("POST", path, body, { idempotencyKey: "other" }))).toMatch(/NOT_SUBJECT_AGENT/);

    await a.revoke("lost");
    expect(await errCode(a.succeed(generateKeypair()))).toMatch(/AGENT_REVOKED/);
  });
});

describe("consumers treat a succeeded ID as retired", () => {
  it("x402, A2A and trust decisions refuse it and name the successor", async () => {
    const { decideX402 } = await import("../sdk-js/src/x402.js");
    const { decideTrust } = await import("../sdk-js/src/trust.js");
    const agent = { id: "did:key:zOld", linked: { erc8004_id: "0xabc" }, succeededBy: "did:key:zNew" } as never;
    const rep = { trustScore: 90, evidenceLevel: "independently_verified", flags: [] } as never;
    expect(decideX402(agent, rep, ["0xabc"]).reason).toMatch(/succeeded by did:key:zNew/);
    expect(decideTrust(agent, rep).decision).toBe("deny");
  });
});
