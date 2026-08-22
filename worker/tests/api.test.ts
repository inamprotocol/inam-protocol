import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { generateKeypair, sha256Hex, sign, toBase64 } from "../../src/crypto/keys.js";
import type { Keypair } from "../../src/crypto/keys.js";

// Inlined rather than read from ../schema.sql at runtime: this test file
// executes inside the Workers-simulated environment (via @cloudflare/vitest-plugin),
// where Node's fs path resolution from import.meta.url does not reliably map
// back to the host filesystem on Windows. Keep this in sync with schema.sql.
// One statement per array entry (not exec() with a multi-line blob) — D1's
// exec() splits on newlines and chokes on a CREATE TABLE spanning several.
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, capabilities TEXT NOT NULL, metadata TEXT NOT NULL, linked TEXT NOT NULL, stake_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS receipts (receipt_id TEXT PRIMARY KEY, agent_a_id TEXT NOT NULL REFERENCES agents(id), agent_b_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, completed_at TEXT NOT NULL, amount_usd REAL NOT NULL DEFAULT 0, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_receipts_agent_a ON receipts(agent_a_id)",
  "CREATE INDEX IF NOT EXISTS idx_receipts_agent_b ON receipts(agent_b_id)",
];

beforeAll(async () => {
  await env.DB.batch(SCHEMA_STATEMENTS.map((s) => env.DB.prepare(s)));
});

async function call(method: string, path: string, opts?: { body?: unknown; keypair?: Keypair; idempotencyKey?: string; ip?: string }) {
  const rawBody = opts?.body !== undefined ? JSON.stringify(opts.body) : "";
  // Each call gets its own synthetic source IP by default so registration
  // calls across different tests never share the IP-scoped rate-limit
  // bucket. The dedicated rate-limiting test below overrides this with a
  // fixed IP specifically to exercise the limit.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": opts?.ip ?? crypto.randomUUID(),
  };

  if (opts?.keypair) {
    const timestamp = Date.now().toString();
    const bodyHash = sha256Hex(rawBody);
    const signingString = `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
    const signature = toBase64(sign(new TextEncoder().encode(signingString), opts.keypair.privateKey));
    headers["inam-agent"] = opts.keypair.did;
    headers["inam-timestamp"] = timestamp;
    headers["inam-signature"] = signature;
  }
  if (opts?.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;

  const request = new Request(`http://worker.test${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? rawBody : undefined,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const json = await response.json().catch(() => undefined);
  return { status: response.status, json };
}

function job(overrides?: Partial<Record<string, unknown>>) {
  const now = new Date().toISOString();
  return {
    jobId: `job_${Math.random().toString(36).slice(2)}`,
    task: { capability: "test.capability", specHash: "sha256:spec", createdAt: now },
    result: { outputHash: "sha256:out", completedAt: now },
    settlement: { amount: "10.00", currency: "USDC" },
    verification: { method: "payer_confirmation", outcome: "success" },
    ...overrides,
  };
}

describe("health", () => {
  it("responds ok", async () => {
    const { status, json } = await call("GET", "/v1/health");
    expect(status).toBe(200);
    expect(json).toEqual({ status: "ok" });
  });
});

describe("agent registration", () => {
  it("registers a new agent", async () => {
    const kp = generateKeypair();
    const { status, json } = await call("POST", "/v1/agents", {
      keypair: kp,
      idempotencyKey: `reg:${kp.did}`,
      body: { capabilities: ["x"] },
    });
    expect(status).toBe(201);
    expect((json as { id: string }).id).toBe(kp.did);
  });

  it("rejects a racing duplicate registration with a fresh idempotency key", async () => {
    const kp = generateKeypair();
    await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `first:${Date.now()}`, body: { capabilities: ["x"] } });
    const { status, json } = await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `second:${Date.now()}`, body: { capabilities: ["x"] } });
    expect(status).toBe(409);
    expect((json as { error: { code: string } }).error.code).toBe("AGENT_ALREADY_REGISTERED");
  });

  it("replays the identical response for a repeated idempotency key", async () => {
    const kp = generateKeypair();
    const key = `idem:${kp.did}`;
    const first = await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: key, body: { capabilities: ["x"] } });
    const second = await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: key, body: { capabilities: ["x"] } });
    expect(second.status).toBe(first.status);
    expect(second.json).toEqual(first.json);
  });
});

describe("execution receipt lifecycle", () => {
  it("rejects self-dealing", async () => {
    const kp = generateKeypair();
    await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `reg:${kp.did}`, body: { capabilities: ["x"] } });
    const { status, json } = await call("POST", "/v1/receipts", {
      keypair: kp,
      idempotencyKey: `receipt:${Date.now()}`,
      body: { ...job(), agentAId: kp.did, signature: "invalid-but-unchecked-before-self-deal-check" },
    });
    expect(status).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe("SELF_DEALING");
  });

  it("goes draft -> finalized only once both signatures verify, then feeds reputation", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../src/core/receiptContent.js");

    const input = job();
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSigningBytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
    const draftSig = toBase64(sign(draftSigningBytes, worker_.privateKey));

    const draftRes = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    expect(draftRes.status).toBe(201);
    const draft = draftRes.json as { receiptId: string; status: string };
    expect(draft.status).toBe("draft");

    // Duplicate submission of identical content, fresh idempotency key so it
    // actually reaches the DB-level duplicate check instead of replaying.
    const dup = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt-retry:${Date.now()}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    expect(dup.status).toBe(409);
    expect((dup.json as { error: { code: string } }).error.code).toBe("DUPLICATE_RECEIPT");

    const counterContent = { ...content, dispute: undefined, receiptId: draft.receiptId };
    const counterSigningBytes = new TextEncoder().encode(canonicalize(counterContent));
    const counterSig = toBase64(sign(counterSigningBytes, requester.privateKey));

    const finalizedRes = await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
      keypair: requester,
      idempotencyKey: `countersign:${draft.receiptId}`,
      body: { signature: counterSig },
    });
    expect(finalizedRes.status).toBe(200);
    expect((finalizedRes.json as { status: string }).status).toBe("finalized");

    const repRes = await call("GET", `/v1/agents/${encodeURIComponent(worker_.did)}/reputation`);
    expect(repRes.status).toBe(200);
    expect((repRes.json as { components: { verifiedReceipts: number } }).components.verifiedReceipts).toBe(1);
  });

  it("only lets one of two concurrent countersign attempts succeed (race-condition fix regression test)", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../src/core/receiptContent.js");

    const input = job();
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
    const draftRes = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    const draft = draftRes.json as { receiptId: string };

    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), requester.privateKey));

    // Two concurrent countersign calls for the SAME draft, each with its own
    // idempotency key so neither is short-circuited by the idempotency cache
    // — this is exactly the race the compare-and-swap fix in
    // worker/src/db.ts's finalizeReceiptIfDraft() targets.
    const [a, b] = await Promise.all([
      call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
        keypair: requester,
        idempotencyKey: `countersign-a:${Date.now()}`,
        body: { signature: counterSig },
      }),
      call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
        keypair: requester,
        idempotencyKey: `countersign-b:${Date.now()}`,
        body: { signature: counterSig },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("rejects countersign from anyone other than agent_a", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    const stranger = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../src/core/receiptContent.js");
    const input = job();
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
    const draftRes = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    const draft = draftRes.json as { receiptId: string };

    const wrongSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), stranger.privateKey));
    const { status, json } = await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
      keypair: stranger,
      idempotencyKey: `countersign:${Date.now()}`,
      body: { signature: wrongSig },
    });
    expect(status).toBe(403);
    expect((json as { error: { code: string } }).error.code).toBe("NOT_REQUESTER");
  });
});

describe("rate limiting", () => {
  it("blocks registration after the per-IP limit is exceeded", async () => {
    const ip = "203.0.113.55"; // fixed on purpose — this test deliberately exhausts one bucket
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const kp = generateKeypair();
      const res = await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `reg:${kp.did}`, body: { capabilities: ["x"] }, ip });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe("CORS", () => {
  it("allows any origin on a public read endpoint", async () => {
    const request = new Request("http://worker.test/v1/health", { headers: { origin: "https://example.com" } });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("sets no CORS header on a mutating endpoint", async () => {
    const kp = generateKeypair();
    const request = new Request("http://worker.test/v1/agents", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({ capabilities: ["x"] }),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
