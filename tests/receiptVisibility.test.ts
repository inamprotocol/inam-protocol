import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { generateKeypair, sign, toBase64, sha256Hex } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent, setVerifierStatus } from "../src/services/agentService.js";
import { testOperatorKeypair } from "./testOperator.js";
import { buildSignableContent, createDraft, countersign } from "../src/services/receiptService.js";
import { buildSignableVerificationContent, submitVerification } from "../src/services/verificationService.js";
import { computeReputation } from "../src/services/reputationService.js";
import type { CreateDraftInput } from "../src/services/receiptService.js";
import type { VerificationContentInput } from "../src/services/verificationService.js";

// SPEC.md §4.4 (v0.19): `participants_only` gates receipt content to its
// two parties and any verifier that's attested it; everyone else (including
// an anonymous caller) gets RECEIPT_NOT_VISIBLE. Real HTTP against a real
// server, not service-level calls, since the gating lives in the route
// layer (src/routes/receipts.ts, src/routes/agents.ts) -- same reasoning as
// tests/malformedRequests.test.ts.
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function signedGetHeaders(path: string, keypair: ReturnType<typeof generateKeypair>): Record<string, string> {
  const timestamp = Date.now().toString();
  const bodyHash = sha256Hex("");
  const signingString = `GET\n${path}\n${timestamp}\n${bodyHash}`;
  const signature = toBase64(sign(new TextEncoder().encode(signingString), keypair.privateKey));
  return { "inam-agent": keypair.did, "inam-timestamp": timestamp, "inam-signature": signature };
}

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

  const counterContent = { ...draft, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
  const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize(counterContent)), requester.privateKey));
  return countersign(draft.receiptId, requester.did, counterSig);
}

describe("receipt visibility (SPEC.md §4.4)", () => {
  it("gates GET /receipts/:id to participants and attesting verifiers, 403s everyone else, and leaves public receipts unrestricted", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(verifier.did, { capabilities: ["verification"] });
    registerAgent(stranger.did, { capabilities: ["y"] });
    setVerifierStatus(testOperatorKeypair.did, verifier.did, true);

    const restricted = finalizeReceipt(requester, provider, `job_vis_${Math.random()}`, "participants_only");
    expect(restricted.visibility).toBe("participants_only");
    const publicReceipt = finalizeReceipt(requester, provider, `job_vis_pub_${Math.random()}`, "public");
    const defaultReceipt = finalizeReceipt(requester, provider, `job_vis_default_${Math.random()}`); // no visibility passed -> defaults to public

    const path = `/v1/receipts/${encodeURIComponent(restricted.receiptId)}`;

    // Both parties can fetch the restricted receipt in full.
    for (const party of [requester, provider]) {
      const res = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path, party) });
      expect(res.status).toBe(200);
    }

    // An unrelated third agent is rejected, signed or not.
    const strangerRes = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path, stranger) });
    expect(strangerRes.status).toBe(403);
    expect(((await strangerRes.json()) as { error: { code: string } }).error.code).toBe("RECEIPT_NOT_VISIBLE");

    // A fully anonymous (unsigned) GET is rejected the same way.
    const anonRes = await fetch(`${baseUrl}${path}`);
    expect(anonRes.status).toBe(403);
    expect(((await anonRes.json()) as { error: { code: string } }).error.code).toBe("RECEIPT_NOT_VISIBLE");

    // A verifier that hasn't attested this receipt yet is still rejected.
    const verifierBeforeRes = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path, verifier) });
    expect(verifierBeforeRes.status).toBe(403);

    // Once the verifier attests the receipt, it can see it.
    const verificationInput: VerificationContentInput = {
      receiptId: restricted.receiptId,
      jobId: restricted.jobId,
      provider: provider.did,
      verifier: verifier.did,
      method: "deterministic",
      outputHash: restricted.result.outputHash,
      result: "verified",
    };
    const vContent = buildSignableVerificationContent(verificationInput);
    const vSignature = toBase64(sign(new TextEncoder().encode(canonicalize(vContent)), verifier.privateKey));
    submitVerification(verifier.did, { ...verificationInput, signature: vSignature });

    const verifierAfterRes = await fetch(`${baseUrl}${path}`, { headers: signedGetHeaders(path, verifier) });
    expect(verifierAfterRes.status).toBe(200);

    // GET /receipts/:id/verifications is gated the same way as the receipt itself.
    const verificationsPath = `${path}/verifications`;
    const strangerVerificationsRes = await fetch(`${baseUrl}${verificationsPath}`, { headers: signedGetHeaders(verificationsPath, stranger) });
    expect(strangerVerificationsRes.status).toBe(403);
    const partyVerificationsRes = await fetch(`${baseUrl}${verificationsPath}`, { headers: signedGetHeaders(verificationsPath, requester) });
    expect(partyVerificationsRes.status).toBe(200);
    expect(((await partyVerificationsRes.json()) as { verifications: unknown[] }).verifications).toHaveLength(1);

    // A public receipt (explicit or default) stays visible to a stranger and anonymously -- no regression.
    for (const r of [publicReceipt, defaultReceipt]) {
      const publicPath = `/v1/receipts/${encodeURIComponent(r.receiptId)}`;
      const res = await fetch(`${baseUrl}${publicPath}`);
      expect(res.status).toBe(200);
    }
  });

  it("omits a participants_only receipt from a non-participant's GET /agents/:id/receipts listing but keeps it in each participant's own", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const stranger = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });
    registerAgent(stranger.did, { capabilities: ["y"] });

    const restricted = finalizeReceipt(requester, provider, `job_vis_list_${Math.random()}`, "participants_only");

    const listPath = `/v1/agents/${encodeURIComponent(provider.did)}/receipts`;

    const strangerListRes = await fetch(`${baseUrl}${listPath}`, { headers: signedGetHeaders(listPath, stranger) });
    expect(strangerListRes.status).toBe(200);
    const strangerReceipts = ((await strangerListRes.json()) as { receipts: { receiptId: string }[] }).receipts;
    expect(strangerReceipts.some((r) => r.receiptId === restricted.receiptId)).toBe(false);

    const anonListRes = await fetch(`${baseUrl}${listPath}`);
    const anonReceipts = ((await anonListRes.json()) as { receipts: { receiptId: string }[] }).receipts;
    expect(anonReceipts.some((r) => r.receiptId === restricted.receiptId)).toBe(false);

    for (const party of [requester, provider]) {
      const res = await fetch(`${baseUrl}${listPath}`, { headers: signedGetHeaders(listPath, party) });
      const receipts = ((await res.json()) as { receipts: { receiptId: string }[] }).receipts;
      expect(receipts.some((r) => r.receiptId === restricted.receiptId)).toBe(true);
    }
  });

  it("does not exclude a participants_only receipt from reputation math -- visibility gates reading, not scoring", () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(provider.did, { capabilities: ["x"] });

    const before = computeReputation(provider.did);
    finalizeReceipt(requester, provider, `job_vis_rep_${Math.random()}`, "participants_only");
    const after = computeReputation(provider.did);

    expect(after.components.rawReceipts).toBe(before.components.rawReceipts + 1);
    expect(after.components.verifiedReceipts).toBe(before.components.verifiedReceipts + 1);
  });
});
