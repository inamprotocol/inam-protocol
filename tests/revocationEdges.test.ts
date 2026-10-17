import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { InamClient } from "../sdk-js/src/client.js";
import { generateKeypair, sha256Hex, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { SUCCESSION_WINDOW_MS, successionClock } from "../sdk-js/src/core/succession.js";

// SPEC.md §2.2 / §2.3 edge cases + signed-request timestamp freshness (STALE_SIGNATURE).
let server: Server;
let baseUrl: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer().listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  successionClock.now = () => Date.now();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const hash = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const client = () => new InamClient(baseUrl, generateKeypair());
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

function draftFor(worker: InamClient, requester: InamClient) {
  const jobId = `job_${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  return worker.submitWork(requester.did, {
    jobId,
    task: { capability: "translation.tr-en", specHash: hash(`spec ${jobId}`), createdAt: now },
    result: { outputHash: hash(`out ${jobId}`), completedAt: now },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
}

describe("revocation edge cases (SPEC.md §2.2)", () => {
  it("a receipt finalized before revocation still counts for the counterparty's reputation", async () => {
    const worker = client();
    const requester = client();
    await worker.registerAgent(["translation.tr-en"]);
    await requester.registerAgent(["job.posting"]);
    const receipt = await requester.acceptWork(await draftFor(worker, requester));
    const before = await worker.getReputation(worker.did);
    expect(before.components.finalizedReceipts).toBe(1);

    await requester.revoke("key suspected compromised");

    const after = await worker.getReputation(worker.did);
    expect(after.components.finalizedReceipts).toBe(1);
    expect(after.trustScore).toBe(before.trustScore);
    expect((await worker.getReceipt(receipt.receiptId)).status).toBe("finalized");
    expect((await worker.getReputation(requester.did)).flags).toContain("revoked");
  });

  it("an open draft cannot be countersigned once its agent_a is revoked", async () => {
    const worker = client();
    const requester = client();
    await worker.registerAgent(["translation.tr-en"]);
    await requester.registerAgent(["job.posting"]);
    const draft = await draftFor(worker, requester);
    await requester.revoke("lost key");

    expect(await errCode(requester.acceptWork(draft))).toMatch(/AGENT_REVOKED/);
    expect((await worker.getReceipt(draft.receiptId)).status).toBe("draft");
    expect((await worker.getReputation(worker.did)).components.finalizedReceipts).toBe(0);
  });
});

describe("succession edge cases (SPEC.md §2.3)", () => {
  it("after activation, a draft naming the predecessor as agent_a is not countersignable by either key", async () => {
    const worker = client();
    const old = client();
    await worker.registerAgent(["translation.tr-en"]);
    await old.registerAgent(["job.posting"]);
    const draft = await draftFor(worker, old);

    const nextKeys = generateKeypair();
    await old.succeed(nextKeys);
    successionClock.now = () => Date.now() + SUCCESSION_WINDOW_MS + 1000;

    expect(await errCode(old.acceptWork(draft))).toMatch(/AGENT_SUCCEEDED/);
    expect(await errCode(new InamClient(baseUrl, nextKeys).acceptWork(draft))).toMatch(/not the receipt's agentA/);
    expect((await worker.getReceipt(draft.receiptId)).status).toBe("draft");
    expect((await worker.getReputation(worker.did)).components.finalizedReceipts).toBe(0);
  });
});

describe("signed-request timestamp freshness (STALE_SIGNATURE)", () => {
  async function getWithTimestamp(offsetMs: number, tsOverride?: string) {
    const kp = generateKeypair();
    const path = "/v1/agents";
    const body = JSON.stringify({ capabilities: ["x"] });
    const ts = tsOverride ?? String(Date.now() + offsetMs);
    const sig = toBase64(sign(new TextEncoder().encode(`POST\n${path}\n${ts}\n${sha256Hex(body)}`), kp.privateKey));
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "inam-agent": kp.did, "inam-timestamp": ts, "inam-signature": sig, "idempotency-key": `ts:${kp.did}` },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as { error?: { code?: string } } };
  }

  it.each([["past", -10 * 60_000], ["future", 10 * 60_000]])("rejects a validly signed request whose timestamp is 10 minutes in the %s", async (_n, off) => {
    const r = await getWithTimestamp(off);
    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe("STALE_SIGNATURE");
  });

  it("rejects a malformed timestamp and accepts one inside the skew", async () => {
    expect((await getWithTimestamp(0, "not-a-number")).json.error?.code).toBe("STALE_SIGNATURE");
    expect((await getWithTimestamp(-60_000)).status).toBe(201);
  });
});
