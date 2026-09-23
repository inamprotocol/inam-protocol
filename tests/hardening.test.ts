import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { generateKeypair, publicKeyToDid, sign, toBase64, fromBase64, sha256Hex, verify, verifyRawEd25519 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import * as jobService from "../src/services/jobService.js";
import { buildSignableContent, createDraft, countersign } from "../src/services/receiptService.js";
import { computeReputation } from "../src/services/reputationService.js";
import { InamClient } from "../sdk-js/src/client.js";
import type { ExecutionReceipt } from "../sdk-js/src/types.js";
import type { CreateDraftInput } from "../src/services/receiptService.js";

// External review's batch of small hardening findings, fixed together
// (STATUS.md item 5). Each sub-fix gets its own describe block.

// ---- small-order Ed25519 key rejection ----

describe("small-order Ed25519 key rejection", () => {
  // The order-2 point on Ed25519 (x=0, y=-1 mod p), a well-known low-order
  // torsion point -- for it, the verification equation is satisfiable by
  // arbitrary signature bytes with no private key at all.
  const ORDER_2_POINT_HEX = "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";

  it("rejects a did:key built from a small-order point regardless of the signature bytes", () => {
    const smallOrderKey = fromHex(ORDER_2_POINT_HEX);
    const did = publicKeyToDid(smallOrderKey);
    const message = new TextEncoder().encode("anything");
    const garbageSignature = fromHex("00".repeat(64));
    expect(verify(garbageSignature, message, did)).toBe(false);
    expect(verifyRawEd25519(garbageSignature, message, smallOrderKey)).toBe(false);
  });

  function fromHex(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, "hex"));
  }
});

// ---- HTTP-level fixes: base64 replay-guard tolerance, draft-spam
// visibility, participants_only job leak ----

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

function signedHeaders(kp: ReturnType<typeof generateKeypair>, method: string, path: string, rawBody: string) {
  const timestamp = String(Date.now());
  const signingString = `${method}\n${path}\n${timestamp}\n${sha256Hex(rawBody)}`;
  return {
    "content-type": "application/json",
    "inam-agent": kp.did,
    "inam-timestamp": timestamp,
    "inam-signature": toBase64(sign(new TextEncoder().encode(signingString), kp.privateKey)),
  };
}

function signedGetHeaders(path: string, kp: ReturnType<typeof generateKeypair>) {
  return signedHeaders(kp, "GET", path, "");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// A 64-byte Ed25519 signature base64-encodes with one leftover byte in its
// final group, whose low 4 bits are unused by the decoder — flipping them
// yields a different STRING that decodes to the exact same bytes.
function mutateBase64Tail(b64: string): string {
  const chars = b64.split("");
  let i = chars.length - 1;
  while (chars[i] === "=") i--;
  const val = BASE64_ALPHABET.indexOf(chars[i]);
  chars[i] = BASE64_ALPHABET[val ^ 0x0f];
  return chars.join("");
}

describe("replay guard: base64 non-canonical re-encoding", () => {
  it("still catches a replay whose inam-signature header was re-encoded to a different string decoding to the same bytes", async () => {
    const kp = generateKeypair();
    await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: { ...signedHeaders(kp, "POST", "/v1/agents", JSON.stringify({ capabilities: ["x"] })), "idempotency-key": `reg:${kp.did}` },
      body: JSON.stringify({ capabilities: ["x"] }),
    });

    const body = JSON.stringify({ capability: "x", specHash: "sha256:b64_replay_spec" });
    const headers = signedHeaders(kp, "POST", "/v1/jobs", body);
    const mutatedSig = mutateBase64Tail(headers["inam-signature"]);
    expect(mutatedSig).not.toBe(headers["inam-signature"]);
    expect(fromBase64(mutatedSig)).toEqual(fromBase64(headers["inam-signature"]));

    const first = await fetch(`${baseUrl}/v1/jobs`, { method: "POST", headers: { ...headers, "idempotency-key": "b64-key-A" }, body });
    expect(first.status).toBe(201);

    const replay = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { ...headers, "inam-signature": mutatedSig, "idempotency-key": "b64-key-B" },
      body,
    });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("REPLAYED_REQUEST");
  });
});

function finalizeReceipt(
  requester: ReturnType<typeof generateKeypair>,
  provider: ReturnType<typeof generateKeypair>,
  jobId: string,
  visibility?: "public" | "participants_only",
) {
  const now = new Date().toISOString();
  const input: Omit<CreateDraftInput, "signature" | "agentAId"> = {
    jobId,
    task: { capability: "x", specHash: "sha256:spec", createdAt: now },
    result: { outputHash: "sha256:out", completedAt: now },
    verification: { method: "payer_confirmation", outcome: "success" },
    visibility,
  };
  const content = buildSignableContent(requester.did, provider.did, input);
  const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
  const draft = createDraft(provider.did, { ...input, agentAId: requester.did, signature: draftSig });
  return { draft, requester, provider };
}

describe("draft receipts are restricted regardless of visibility, and excluded from rawReceipts", () => {
  it("403s a stranger's GET on a public-visibility draft, and only counts it toward reputation once finalized", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(stranger.did, { capabilities: ["y"] });

    const before = computeReputation(provider.did);
    const { draft } = finalizeReceipt(requester, provider, `job_draft_${Math.random()}`, "public");
    expect(draft.status).toBe("draft");
    // SPEC v0.31: no dispute window until countersigned: null, not "".
    expect(draft.dispute.windowClosesAt).toBeNull();

    const path = `/v1/receipts/${encodeURIComponent(draft.receiptId)}`;
    const strangerRes = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path, stranger) });
    expect(strangerRes.status).toBe(403);
    expect(((await strangerRes.json()) as { error: { code: string } }).error.code).toBe("RECEIPT_NOT_VISIBLE");

    // Still a draft: no reputation impact yet, for either party.
    const stillDraft = computeReputation(provider.did);
    expect(stillDraft.components.rawReceipts).toBe(before.components.rawReceipts);

    // Once countersigned, it's finalized and counts as normal.
    const counterContent = { ...draft, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize(counterContent)), requester.privateKey));
    const finalized = countersign(draft.receiptId, requester.did, counterSig);
    expect(Number.isNaN(Date.parse(finalized.dispute.windowClosesAt ?? ""))).toBe(false);
    const after = computeReputation(provider.did);
    expect(after.components.rawReceipts).toBe(before.components.rawReceipts + 1);
  });
});

describe("countersign-blind-signing guard (sdk-js InamClient.acceptWork)", () => {
  function fixtureReceipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
    return {
      receiptVersion: "1.0",
      receiptId: "sha256:fixture",
      jobId: "job_fixture",
      agentA: { id: "did:key:zAgentA", role: "requester" },
      agentB: { id: "did:key:zAgentB", role: "worker" },
      task: { capability: "x", specHash: "sha256:spec", createdAt: new Date().toISOString() },
      result: { outputHash: "sha256:out", completedAt: new Date().toISOString() },
      verification: { method: "payer_confirmation", outcome: "success" },
      dispute: { status: "none", windowClosesAt: null },
      signatures: { agentB: "sig" },
      status: "draft",
      visibility: "public",
      ...overrides,
    };
  }

  it("refuses to sign a receipt whose agentA isn't this client, before making any request", async () => {
    const requester = generateKeypair();
    const client = new InamClient("http://127.0.0.1:1", requester);
    const receipt = fixtureReceipt({ agentA: { id: "did:key:zSomeoneElse", role: "requester" } });
    await expect(client.acceptWork(receipt)).rejects.toThrow(/not the receipt's agentA/);
  });

  it("refuses to sign when the caller's expected jobId/outputHash don't match the fetched draft", async () => {
    const requester = generateKeypair();
    const client = new InamClient("http://127.0.0.1:1", requester);
    const receipt = fixtureReceipt({ agentA: { id: requester.did, role: "requester" } });

    await expect(client.acceptWork(receipt, { jobId: "job_other" })).rejects.toThrow(/expected jobId/);
    await expect(client.acceptWork(receipt, { outputHash: "sha256:different" })).rejects.toThrow(/expected result.outputHash/);
  });
});

describe("participants_only job record leak via GET /jobs", () => {
  it("403s GET /jobs/:id and omits the job from /jobs/search for a non-participant once its receipt is participants_only", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(stranger.did, { capabilities: ["y"] });

    const job = jobService.postJob(requester.did, { capability: "x", specHash: "sha256:spec" });
    jobService.submitOffer(job.jobId, provider.did, "on it");
    jobService.acceptOffer(job.jobId, requester.did, provider.did);

    const { draft } = finalizeReceipt(requester, provider, job.jobId, "participants_only");
    const counterContent = { ...draft, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize(counterContent)), requester.privateKey));
    countersign(draft.receiptId, requester.did, counterSig);

    const jobPath = `/v1/jobs/${encodeURIComponent(job.jobId)}`;
    const strangerRes = await fetch(`${baseUrl}${jobPath}`, { headers: signedGetHeaders(jobPath, stranger) });
    expect(strangerRes.status).toBe(403);
    expect(((await strangerRes.json()) as { error: { code: string } }).error.code).toBe("JOB_NOT_VISIBLE");

    for (const party of [requester, provider]) {
      const res = await fetch(`${baseUrl}${jobPath}`, { headers: signedGetHeaders(jobPath, party) });
      expect(res.status).toBe(200);
    }

    const searchRes = await fetch(`${baseUrl}/v1/jobs/search`, { headers: signedGetHeaders("/v1/jobs/search", stranger) });
    const strangerJobs = ((await searchRes.json()) as { jobs: { jobId: string }[] }).jobs;
    expect(strangerJobs.some((j) => j.jobId === job.jobId)).toBe(false);

    const partySearchRes = await fetch(`${baseUrl}/v1/jobs/search`, { headers: signedGetHeaders("/v1/jobs/search", requester) });
    const partyJobs = ((await partySearchRes.json()) as { jobs: { jobId: string }[] }).jobs;
    expect(partyJobs.some((j) => j.jobId === job.jobId)).toBe(true);
  });
});
