import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { generateKeypair, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { registerAgent } from "../src/services/agentService.js";
import { buildSignableContent, createDraft, countersign } from "../src/services/receiptService.js";
import { computeReputation } from "../src/services/reputationService.js";
import type { CreateDraftInput } from "../src/services/receiptService.js";

// Route-level (real HTTP, real Express app + middleware, not just the
// badgeService.ts pure functions) so CORS/Content-Type/Cache-Control wiring
// and the AGENT_NOT_FOUND -> graceful-badge catch in src/routes/agents.ts are
// actually exercised, matching how worker/tests/api.test.ts covers its side.
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

function signDraft(agentAId: string, agentBPrivateKey: Uint8Array, agentBId: string, input: Omit<CreateDraftInput, "signature" | "agentAId">) {
  const content = buildSignableContent(agentAId, agentBId, input);
  const bytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  return toBase64(sign(bytes, agentBPrivateKey));
}

function signCountersign(receipt: ReturnType<typeof createDraft>, agentAPrivateKey: Uint8Array) {
  const content = { ...receipt, signatures: undefined, status: undefined, dispute: undefined };
  const bytes = new TextEncoder().encode(canonicalize(content));
  return toBase64(sign(bytes, agentAPrivateKey));
}

function freshInput(jobId: string): Omit<CreateDraftInput, "signature" | "agentAId"> {
  const now = new Date().toISOString();
  return {
    jobId,
    task: { capability: "translation.tr-en", specHash: `sha256:spec_${jobId}`, createdAt: now },
    result: { outputHash: `sha256:out_${jobId}`, completedAt: now },
    settlement: { amount: "12.50", currency: "USDC" },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
}

describe("GET /agents/:id/badge.svg, /agents/:id/badge.json", () => {
  it("renders a color-coded SVG badge matching computeReputation()'s own score for an agent with real history", async () => {
    const requester = generateKeypair();
    const worker = generateKeypair();
    registerAgent(requester.did, { capabilities: ["job.posting"] });
    registerAgent(worker.did, { capabilities: ["translation.tr-en"] });

    const input = freshInput("badge_job_scored");
    const signature = signDraft(requester.did, worker.privateKey, worker.did, input);
    const draft = createDraft(worker.did, { ...input, agentAId: requester.did, signature });
    countersign(draft.receiptId, requester.did, signCountersign(draft, requester.privateKey));

    const rep = computeReputation(worker.did);
    expect(rep.components.verifiedReceipts).toBe(1);
    const expectedValue = Number.isInteger(rep.trustScore) ? String(rep.trustScore) : rep.trustScore.toFixed(1);

    const res = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(worker.did)}/badge.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    const text = await res.text();
    expect(text).toContain("<svg");
    expect(text).toContain(">inam<");
    expect(text).toContain(`>${expectedValue}<`);
    expect(text).not.toContain(">new<");
    expect(text).not.toContain(">unknown<");

    const jsonRes = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(worker.did)}/badge.json`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toMatch(/application\/json/);
    const json = (await jsonRes.json()) as { schemaVersion: number; label: string; message: string; status: string; trustScore: number };
    expect(json).toMatchObject({ schemaVersion: 1, label: "inam", message: expectedValue, status: "scored", trustScore: rep.trustScore });
  });

  it("renders a distinct neutral grey 'new' badge for a brand-new agent with zero receipt history, not a red/orange penalized color", async () => {
    const fresh = generateKeypair();
    registerAgent(fresh.did, { capabilities: ["x"] });

    const res = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(fresh.did)}/badge.svg`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(">new<");
    expect(text).toContain("#9f9f9f");

    const jsonRes = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(fresh.did)}/badge.json`);
    expect(jsonRes.status).toBe(200);
    const json = await jsonRes.json();
    expect(json).toMatchObject({ schemaVersion: 1, label: "inam", message: "new", status: "new" });
  });

  it("renders a graceful unknown-state badge for an unregistered did:key (never a 404 or broken image), while /reputation itself still 404s", async () => {
    const unknownDid = "did:key:z6MkNoSuchAgentEverRegisteredOnNodeSide0";

    const repRes = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(unknownDid)}/reputation`);
    expect(repRes.status).toBe(404);
    const repJson = (await repRes.json()) as { error: { code: string } };
    expect(repJson.error.code).toBe("AGENT_NOT_FOUND");

    const badgeRes = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(unknownDid)}/badge.svg`);
    expect(badgeRes.status).toBe(200);
    expect(badgeRes.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    const text = await badgeRes.text();
    expect(text).toContain("<svg");
    expect(text).toContain(">unknown<");

    const jsonRes = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(unknownDid)}/badge.json`);
    expect(jsonRes.status).toBe(200);
    const json = await jsonRes.json();
    expect(json).toMatchObject({ schemaVersion: 1, label: "inam", message: "unknown", status: "not_found" });
  });

  it("never interpolates agent-supplied metadata (e.g. a malicious display name) into the rendered badge", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"], metadata: { name: '<script>alert(1)</script>&"malicious"' } });

    const res = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(agent.did)}/badge.svg`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("malicious");
  });
});
