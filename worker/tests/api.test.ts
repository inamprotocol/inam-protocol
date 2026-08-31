import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { generateKeypair, sha256Hex, sign, toBase64 } from "../../sdk-js/src/crypto/keys.js";
import { generateP256Keypair, p256Sign } from "../../sdk-js/src/crypto/p256.js";
import type { Keypair } from "../../sdk-js/src/crypto/keys.js";
import { testOperatorKeypair } from "./testOperator.js";

// Inlined rather than read from ../schema.sql at runtime: this test file
// executes inside the Workers-simulated environment (via @cloudflare/vitest-plugin),
// where Node's fs path resolution from import.meta.url does not reliably map
// back to the host filesystem on Windows. Keep this in sync with schema.sql.
// One statement per array entry (not exec() with a multi-line blob) — D1's
// exec() splits on newlines and chokes on a CREATE TABLE spanning several.
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, capabilities TEXT NOT NULL, metadata TEXT NOT NULL, linked TEXT NOT NULL, linked_proof TEXT NOT NULL DEFAULT '{}', stake_usd REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, is_authorized_verifier INTEGER NOT NULL DEFAULT 0, revoked_at TEXT, revocation_reason TEXT)",
  "CREATE TABLE IF NOT EXISTS receipts (receipt_id TEXT PRIMARY KEY, agent_a_id TEXT NOT NULL REFERENCES agents(id), agent_b_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, completed_at TEXT NOT NULL, amount_usd REAL NOT NULL DEFAULT 0, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_receipts_agent_a ON receipts(agent_a_id)",
  "CREATE INDEX IF NOT EXISTS idx_receipts_agent_b ON receipts(agent_b_id)",
  "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, posted_by TEXT NOT NULL REFERENCES agents(id), capability TEXT NOT NULL, spec_hash TEXT NOT NULL, budget_amount TEXT, budget_currency TEXT, status TEXT NOT NULL, accepted_agent_id TEXT, receipt_id TEXT, created_at TEXT NOT NULL, expires_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_capability_status ON jobs(capability, status)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_posted_by ON jobs(posted_by)",
  "CREATE TABLE IF NOT EXISTS job_offers (job_id TEXT NOT NULL REFERENCES jobs(job_id), agent_id TEXT NOT NULL, message TEXT, created_at TEXT NOT NULL, PRIMARY KEY (job_id, agent_id))",
  "CREATE TABLE IF NOT EXISTS link_challenges (challenge_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), protocol TEXT NOT NULL, external_public_key TEXT NOT NULL, key_type TEXT NOT NULL, challenge TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS verifications (verification_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id), provider TEXT NOT NULL, verifier TEXT NOT NULL, result TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_verifications_receipt ON verifications(receipt_id)",
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

// Grants verifier status via the real, signed operator endpoint (SPEC.md
// §12.3) using the fixed test-operator keypair injected as env.OPERATOR_DID
// in ../vitest.config.ts. Used everywhere a test needs an agent to actually
// be able to submit a Verification -- registration alone is no longer
// enough since an audit found that gave verifier count no relationship to
// real independence.
async function authorizeVerifier(agent: Keypair) {
  const res = await call("POST", `/v1/agents/${encodeURIComponent(agent.did)}/verifier-status`, {
    keypair: testOperatorKeypair,
    idempotencyKey: `authorize-verifier:${agent.did}:${Date.now()}`,
    body: { authorized: true },
  });
  if (res.status !== 200) throw new Error(`authorizeVerifier failed: ${JSON.stringify(res.json)}`);
}

// Like `call`, but for endpoints that don't return JSON (badge.svg) — hands
// back the raw response so tests can assert on Content-Type/body text.
async function callRaw(path: string, opts?: { ip?: string }) {
  const request = new Request(`http://worker.test${path}`, {
    headers: { "cf-connecting-ip": opts?.ip ?? crypto.randomUUID() },
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
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

describe("malformed request bodies", () => {
  it("returns 400 INVALID_JSON, not 500, for a syntactically invalid but correctly-signed body", async () => {
    // Confirmed live before this fix: signedRequest.ts's JSON.parse(rawBody)
    // had no try/catch, so a malformed body reached app.onError's catch-all
    // as an uncaught SyntaxError and surfaced as a 500 INTERNAL_ERROR --
    // misleadingly reporting a client mistake as a server bug (same
    // underlying issue as the Node reference server's equivalent gap).
    // Signature verification runs *before* JSON.parse here (unlike Node,
    // where express.json() runs as global middleware ahead of any
    // route-specific auth check), so this has to be a genuinely
    // correctly-signed request over the malformed raw bytes to actually
    // reach the JSON.parse failure rather than failing auth first.
    const kp = generateKeypair();
    const rawBody = "{invalid json";
    const path = "/v1/agents";
    const timestamp = Date.now().toString();
    const bodyHash = sha256Hex(rawBody);
    const signingString = `POST\n${path}\n${timestamp}\n${bodyHash}`;
    const signature = toBase64(sign(new TextEncoder().encode(signingString), kp.privateKey));

    const request = new Request(`http://worker.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": crypto.randomUUID(),
        "inam-agent": kp.did,
        "inam-timestamp": timestamp,
        "inam-signature": signature,
        "idempotency-key": "malformed-json-test",
      },
      body: rawBody,
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe("INVALID_JSON");
  });
});

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

  it("rejects a captured request replayed with a different Idempotency-Key (audit #8)", async () => {
    // The signing string doesn't cover the Idempotency-Key, so a captured
    // signed request replayed with a fresh key would otherwise re-execute:
    // signature still verifies, idempotency cache (keyed on the new key)
    // misses. The replay guard binds one verified signature to one key.
    const poster = generateKeypair();
    await call("POST", "/v1/agents", { keypair: poster, idempotencyKey: `reg:${poster.did}`, body: { capabilities: ["job.posting"] } });

    const body = JSON.stringify({ capability: "translation.tr-en", specHash: "sha256:replay_worker" });
    const path = "/v1/jobs";
    const timestamp = Date.now().toString();
    const signingString = `POST\n${path}\n${timestamp}\n${sha256Hex(body)}`;
    const signature = toBase64(sign(new TextEncoder().encode(signingString), poster.privateKey));
    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      "cf-connecting-ip": crypto.randomUUID(),
      "inam-agent": poster.did,
      "inam-timestamp": timestamp,
      "inam-signature": signature,
    };
    const fire = async (idempotencyKey: string) => {
      const request = new Request(`http://worker.test${path}`, { method: "POST", headers: { ...baseHeaders, "idempotency-key": idempotencyKey }, body });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);
      return { status: response.status, json: (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined };
    };

    const first = await fire("key-A");
    expect(first.status).toBe(201);
    const jobId = first.json!.jobId as string;

    const replay = await fire("key-B"); // same signature, fresh key
    expect(replay.status).toBe(409);
    expect(replay.json!.error).toMatchObject({ code: "REPLAYED_REQUEST" });

    const verbatim = await fire("key-A"); // exact same request -> idempotent replay
    expect(verbatim.status).toBe(201);
    expect(verbatim.json!.jobId).toBe(jobId);
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

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

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

  it("rejects a future result.completedAt beyond clock-skew tolerance", async () => {
    // An audit found reputationService.ts's decay formula treats a future
    // completedAt as *younger than brand new* (negative age -> decay > 1),
    // unboundedly inflating that receipt's weight. Closed at the source: a
    // receipt with a future completedAt is now rejected at submission.
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    const future = new Date(Date.now() + 60 * 24 * 3600_000).toISOString(); // 60 days from now
    const input = job({ task: { capability: "test.capability", specHash: "sha256:spec", createdAt: future }, result: { outputHash: "sha256:out", completedAt: future } });
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));

    const res = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("INVALID_TIMESTAMP");
  });

  it("rejects result.completedAt before task.createdAt", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    const now = new Date();
    const created = now.toISOString();
    const completedBeforeCreated = new Date(now.getTime() - 3600_000).toISOString(); // 1 hour earlier
    const input = job({ task: { capability: "test.capability", specHash: "sha256:spec", createdAt: created }, result: { outputHash: "sha256:out", completedAt: completedBeforeCreated } });
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));

    const res = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("INVALID_TIMESTAMP");
  });

  it("rejects a non-ISO-8601 completedAt at the schema layer", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    const input = job({ result: { outputHash: "sha256:out", completedAt: "not-a-real-date" } });
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));

    const res = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("distinguishes an agent's provider history from its requester history", async () => {
    // An audit found the aggregate trustScore/components don't distinguish
    // "did the work" from "requested and paid for the work" at all -- two
    // brand-new counterparties finishing one receipt ended up with
    // identical-looking reputations regardless of which side each was on.
    // agentP only ever does work (provider); agentQ both requests work from
    // agentP once and separately does work for agentR once -- so agentQ's
    // asProvider/asRequester counts should differ from each other, and
    // agentP's asRequester should be empty.
    const agentP = generateKeypair();
    const agentQ = generateKeypair();
    const agentR = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agentP, idempotencyKey: `reg:${agentP.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: agentQ, idempotencyKey: `reg:${agentQ.did}`, body: { capabilities: ["job.posting", "x"] } });
    await call("POST", "/v1/agents", { keypair: agentR, idempotencyKey: `reg:${agentR.did}`, body: { capabilities: ["job.posting"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    async function finalize(requester: Keypair, worker_: Keypair, jobId: string) {
      const input = job({ jobId });
      const content = buildSignableContent(requester.did, worker_.did, input);
      const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
      const draftRes = await call("POST", "/v1/receipts", { keypair: worker_, idempotencyKey: `receipt:${jobId}`, body: { ...input, agentAId: requester.did, signature: draftSig } });
      const draft = draftRes.json as { receiptId: string };
      const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), requester.privateKey));
      await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, { keypair: requester, idempotencyKey: `countersign:${draft.receiptId}`, body: { signature: counterSig } });
    }

    // agentQ requests work from agentP (agentQ = requester, agentP = provider).
    await finalize(agentQ, agentP, "job_q_requests_from_p");
    // agentQ separately does work for agentR (agentQ = provider, agentR = requester).
    await finalize(agentR, agentQ, "job_q_provides_for_r");

    const pRep = (await call("GET", `/v1/agents/${encodeURIComponent(agentP.did)}/reputation`)).json as { components: { asProvider: { receipts: number }; asRequester: { receipts: number } } };
    expect(pRep.components.asProvider.receipts).toBe(1);
    expect(pRep.components.asRequester.receipts).toBe(0);

    const qRep = (await call("GET", `/v1/agents/${encodeURIComponent(agentQ.did)}/reputation`)).json as { components: { asProvider: { receipts: number }; asRequester: { receipts: number }; verifiedReceipts: number } };
    expect(qRep.components.asProvider.receipts).toBe(1);
    expect(qRep.components.asRequester.receipts).toBe(1);
    expect(qRep.components.asProvider.receipts + qRep.components.asRequester.receipts).toBe(qRep.components.verifiedReceipts);
  });

  it("buckets settlement volume by currency instead of summing every currency as USD", async () => {
    // An audit found `components.volumeUsd` summed `settlement.amount` across
    // every currency -- a 1000 TRY receipt added 1000 to a USD-labelled
    // field. INAM does no FX, so volume is now bucketed by currency and
    // `volumeUsd` is just the USD bucket.
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    async function finalizeWith(jobId: string, settlement: Record<string, string>) {
      const input = job({ jobId, settlement });
      const content = buildSignableContent(requester.did, worker_.did, input);
      const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
      const draftRes = await call("POST", "/v1/receipts", { keypair: worker_, idempotencyKey: `receipt:${jobId}`, body: { ...input, agentAId: requester.did, signature: draftSig } });
      const draft = draftRes.json as { receiptId: string };
      const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), requester.privateKey));
      await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, { keypair: requester, idempotencyKey: `countersign:${draft.receiptId}`, body: { signature: counterSig } });
    }

    await finalizeWith("job_usd", { amount: "100.00", currency: "USD" });
    await finalizeWith("job_try", { amount: "1000.00", currency: "TRY" });
    await finalizeWith("job_eur", { amount: "50.00", currency: "eur" }); // case-insensitive

    const rep = (await call("GET", `/v1/agents/${encodeURIComponent(worker_.did)}/reputation`)).json as {
      components: { volumeUsd: number; volumeByCurrency: Record<string, number>; asProvider: { volumeUsd: number; volumeByCurrency: Record<string, number> } };
    };
    expect(rep.components.volumeUsd).toBe(100); // the USD receipt only, not 1150
    expect(rep.components.volumeByCurrency).toEqual({ USD: 100, TRY: 1000, EUR: 50 });
    expect(rep.components.asProvider.volumeUsd).toBe(100);
    expect(rep.components.asProvider.volumeByCurrency).toEqual({ USD: 100, TRY: 1000, EUR: 50 });
  });

  it("rejects a malformed settlement amount / free-form currency at the schema layer", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    const input = job({ settlement: { amount: "banana", currency: "USD" } });
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
    const res = await call("POST", "/v1/receipts", { keypair: worker_, idempotencyKey: `receipt:${input.jobId}`, body: { ...input, agentAId: requester.did, signature: draftSig } });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("only lets one of two concurrent countersign attempts succeed (race-condition fix regression test)", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

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

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");
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
    // Fixed *within this run* on purpose (deliberately exhausts one bucket),
    // but unique *per run* — a hardcoded literal here would let residual
    // rate-limit state from local Miniflare's on-disk persistence (.wrangler/state)
    // leak between separate `vitest run` invocations and make this flaky. The
    // rate limiter treats this purely as an opaque key, so it need not be a
    // syntactically valid IP.
    const ip = `test-fixed-ip-${crypto.randomUUID()}`;
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

  it("sets no CORS header on the mixed GET+POST /jobs/:id/offers path's POST", async () => {
    const kp = generateKeypair();
    const request = new Request("http://worker.test/v1/jobs/job_whatever/offers", {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("job lifecycle", () => {
  it("goes open -> accepted -> completed, and rejects the wrong parties along the way", async () => {
    const poster = generateKeypair();
    const worker_ = generateKeypair();
    const stranger = generateKeypair();
    await call("POST", "/v1/agents", { keypair: poster, idempotencyKey: `reg:${poster.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["translation.tr-en"] } });
    await call("POST", "/v1/agents", { keypair: stranger, idempotencyKey: `reg:${stranger.did}`, body: { capabilities: ["translation.tr-en"] } });

    const postRes = await call("POST", "/v1/jobs", {
      keypair: poster,
      idempotencyKey: `job:${Date.now()}`,
      body: { capability: "translation.tr-en", specHash: "sha256:spec_job" },
    });
    expect(postRes.status).toBe(201);
    const jobId = (postRes.json as { jobId: string }).jobId;

    const searchRes = await call("GET", "/v1/jobs/search?capability=translation.tr-en&status=open");
    expect((searchRes.json as { jobs: { jobId: string }[] }).jobs.some((j) => j.jobId === jobId)).toBe(true);

    const selfOffer = await call("POST", `/v1/jobs/${jobId}/offers`, { keypair: poster, idempotencyKey: `o:${Date.now()}`, body: {} });
    expect(selfOffer.status).toBe(400);
    expect((selfOffer.json as { error: { code: string } }).error.code).toBe("SELF_DEALING");

    const offerRes = await call("POST", `/v1/jobs/${jobId}/offers`, {
      keypair: worker_,
      idempotencyKey: `offer:${Date.now()}`,
      body: { message: "I can do this" },
    });
    expect(offerRes.status).toBe(201);

    const dupOffer = await call("POST", `/v1/jobs/${jobId}/offers`, {
      keypair: worker_,
      idempotencyKey: `offer-dup:${Date.now()}`,
      body: {},
    });
    expect(dupOffer.status).toBe(409);
    expect((dupOffer.json as { error: { code: string } }).error.code).toBe("OFFER_ALREADY_SUBMITTED");

    const wrongAccept = await call("POST", `/v1/jobs/${jobId}/accept`, {
      keypair: stranger,
      idempotencyKey: `accept-wrong:${Date.now()}`,
      body: { agentId: worker_.did },
    });
    expect(wrongAccept.status).toBe(403);
    expect((wrongAccept.json as { error: { code: string } }).error.code).toBe("NOT_POSTER");

    const acceptRes = await call("POST", `/v1/jobs/${jobId}/accept`, {
      keypair: poster,
      idempotencyKey: `accept:${Date.now()}`,
      body: { agentId: worker_.did },
    });
    expect(acceptRes.status).toBe(200);
    expect((acceptRes.json as { status: string }).status).toBe("accepted");

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");
    const now = new Date().toISOString();
    const receiptInput = {
      jobId,
      task: { capability: "translation.tr-en", specHash: "sha256:spec_job", createdAt: now },
      result: { outputHash: "sha256:out_job", completedAt: now },
      verification: { method: "payer_confirmation", outcome: "success" },
    };
    const content = buildSignableContent(poster.did, worker_.did, receiptInput);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
    const draftRes = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt:${jobId}`,
      body: { ...receiptInput, agentAId: poster.did, signature: draftSig },
    });
    expect(draftRes.status).toBe(201);
    const receipt = draftRes.json as { receiptId: string };

    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: receipt.receiptId })), poster.privateKey));
    const finalizeRes = await call("POST", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/countersign`, {
      keypair: poster,
      idempotencyKey: `countersign:${receipt.receiptId}`,
      body: { signature: counterSig },
    });
    expect(finalizeRes.status).toBe(200);

    const jobAfter = await call("GET", `/v1/jobs/${jobId}`);
    expect((jobAfter.json as { status: string; receiptId?: string }).status).toBe("completed");
    expect((jobAfter.json as { receiptId?: string }).receiptId).toBe(receipt.receiptId);
  });

  it("rejects a receipt whose parties don't match the job, and one referencing a not-yet-accepted job", async () => {
    const poster = generateKeypair();
    const worker_ = generateKeypair();
    const impostor = generateKeypair();
    await call("POST", "/v1/agents", { keypair: poster, idempotencyKey: `reg:${poster.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: impostor, idempotencyKey: `reg:${impostor.did}`, body: { capabilities: ["x"] } });

    const postRes = await call("POST", "/v1/jobs", {
      keypair: poster,
      idempotencyKey: `job:${Date.now()}`,
      body: { capability: "x", specHash: "sha256:spec_open" },
    });
    const jobId = (postRes.json as { jobId: string }).jobId;

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");
    const now = new Date().toISOString();
    const receiptInput = {
      jobId,
      task: { capability: "x", specHash: "sha256:spec_open", createdAt: now },
      result: { outputHash: "sha256:out_open", completedAt: now },
      verification: { method: "payer_confirmation", outcome: "success" },
    };

    // Not yet accepted at all.
    const contentNotAccepted = buildSignableContent(poster.did, worker_.did, receiptInput);
    const sigNotAccepted = toBase64(sign(new TextEncoder().encode(canonicalize({ ...contentNotAccepted, dispute: undefined })), worker_.privateKey));
    const notAcceptedRes = await call("POST", "/v1/receipts", {
      keypair: worker_,
      idempotencyKey: `receipt-na:${Date.now()}`,
      body: { ...receiptInput, agentAId: poster.did, signature: sigNotAccepted },
    });
    expect(notAcceptedRes.status).toBe(409);
    expect((notAcceptedRes.json as { error: { code: string } }).error.code).toBe("JOB_NOT_ACCEPTED");

    // Accept the real worker, then have an impostor try to submit the receipt.
    await call("POST", `/v1/jobs/${jobId}/offers`, { keypair: worker_, idempotencyKey: `o:${Date.now()}`, body: {} });
    await call("POST", `/v1/jobs/${jobId}/accept`, { keypair: poster, idempotencyKey: `a:${Date.now()}`, body: { agentId: worker_.did } });

    const contentImpostor = buildSignableContent(poster.did, impostor.did, receiptInput);
    const sigImpostor = toBase64(sign(new TextEncoder().encode(canonicalize({ ...contentImpostor, dispute: undefined })), impostor.privateKey));
    const impostorRes = await call("POST", "/v1/receipts", {
      keypair: impostor,
      idempotencyKey: `receipt-imp:${Date.now()}`,
      body: { ...receiptInput, agentAId: poster.did, signature: sigImpostor },
    });
    expect(impostorRes.status).toBe(403);
    expect((impostorRes.json as { error: { code: string } }).error.code).toBe("JOB_PARTY_MISMATCH");
  });

  it("lets the poster cancel an open job, and rejects a non-poster's cancel and a re-cancel", async () => {
    const poster = generateKeypair();
    const stranger = generateKeypair();
    await call("POST", "/v1/agents", { keypair: poster, idempotencyKey: `reg:${poster.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: stranger, idempotencyKey: `reg:${stranger.did}`, body: { capabilities: ["x"] } });

    const postRes = await call("POST", "/v1/jobs", {
      keypair: poster,
      idempotencyKey: `job:${Date.now()}`,
      body: { capability: "x", specHash: "sha256:spec_cancel" },
    });
    const jobId = (postRes.json as { jobId: string }).jobId;

    const wrongCancel = await call("POST", `/v1/jobs/${jobId}/cancel`, { keypair: stranger, idempotencyKey: `c-wrong:${Date.now()}`, body: {} });
    expect(wrongCancel.status).toBe(403);

    const cancelRes = await call("POST", `/v1/jobs/${jobId}/cancel`, { keypair: poster, idempotencyKey: `c:${Date.now()}`, body: {} });
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.json as { status: string }).status).toBe("cancelled");

    const reCancel = await call("POST", `/v1/jobs/${jobId}/cancel`, { keypair: poster, idempotencyKey: `c2:${Date.now()}`, body: {} });
    expect(reCancel.status).toBe(409);
    expect((reCancel.json as { error: { code: string } }).error.code).toBe("JOB_NOT_CANCELLABLE");
  });

  it("only lets one of two concurrent accept attempts on the same job succeed", async () => {
    const poster = generateKeypair();
    const workerA = generateKeypair();
    const workerB = generateKeypair();
    await call("POST", "/v1/agents", { keypair: poster, idempotencyKey: `reg:${poster.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: workerA, idempotencyKey: `reg:${workerA.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: workerB, idempotencyKey: `reg:${workerB.did}`, body: { capabilities: ["x"] } });

    const postRes = await call("POST", "/v1/jobs", {
      keypair: poster,
      idempotencyKey: `job:${Date.now()}`,
      body: { capability: "x", specHash: "sha256:spec_race" },
    });
    const jobId = (postRes.json as { jobId: string }).jobId;
    await call("POST", `/v1/jobs/${jobId}/offers`, { keypair: workerA, idempotencyKey: `oa:${Date.now()}`, body: {} });
    await call("POST", `/v1/jobs/${jobId}/offers`, { keypair: workerB, idempotencyKey: `ob:${Date.now()}`, body: {} });

    const [a, b] = await Promise.all([
      call("POST", `/v1/jobs/${jobId}/accept`, { keypair: poster, idempotencyKey: `accept-a:${Date.now()}`, body: { agentId: workerA.did } }),
      call("POST", `/v1/jobs/${jobId}/accept`, { keypair: poster, idempotencyKey: `accept-b:${Date.now()}`, body: { agentId: workerB.did } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("external identity link challenges", () => {
  it("links agentpass_id after a valid Ed25519 challenge signature", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });
    const external = generateKeypair();

    const chRes = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
      keypair: agent,
      idempotencyKey: `ch:${Date.now()}`,
      body: { protocol: "agentpass_id", externalPublicKey: toBase64(external.publicKey), keyType: "ed25519" },
    });
    expect(chRes.status).toBe(201);
    const { challengeId, challenge } = chRes.json as { challengeId: string; challenge: string };
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);

    const proof = toBase64(sign(new Uint8Array(Buffer.from(challenge, "hex")), external.privateKey));
    const linkRes = await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link:${challengeId}`,
      body: { protocol: "agentpass_id", value: "agentpass:worker-test", challengeId, proofSignature: proof },
    });
    expect(linkRes.status).toBe(200);
    expect((linkRes.json as { linked: { agentpass_id?: string } }).linked.agentpass_id).toBe("agentpass:worker-test");
  });

  it("links passport_id after a valid P-256 challenge signature", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });
    const external = generateP256Keypair();

    const chRes = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
      keypair: agent,
      idempotencyKey: `ch:${Date.now()}`,
      body: { protocol: "passport_id", externalPublicKey: toBase64(external.publicKey), keyType: "p256" },
    });
    const { challengeId, challenge } = chRes.json as { challengeId: string; challenge: string };
    const proof = toBase64(p256Sign(new Uint8Array(Buffer.from(challenge, "hex")), external.privateKey));
    const linkRes = await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link:${challengeId}`,
      body: { protocol: "passport_id", value: "passport:worker-test", challengeId, proofSignature: proof },
    });
    expect(linkRes.status).toBe(200);
    expect((linkRes.json as { linked: { passport_id?: string } }).linked.passport_id).toBe("passport:worker-test");
  });

  it("rejects a signature from the wrong external key", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });
    const external = generateKeypair();
    const impostor = generateKeypair();

    const chRes = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
      keypair: agent,
      idempotencyKey: `ch:${Date.now()}`,
      body: { protocol: "aitp_id", externalPublicKey: toBase64(external.publicKey), keyType: "ed25519" },
    });
    const { challengeId, challenge } = chRes.json as { challengeId: string; challenge: string };
    const badProof = toBase64(sign(new Uint8Array(Buffer.from(challenge, "hex")), impostor.privateKey));
    const linkRes = await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link:${challengeId}`,
      body: { protocol: "aitp_id", value: "aitp:should-fail", challengeId, proofSignature: badProof },
    });
    expect(linkRes.status).toBe(400);
    expect((linkRes.json as { error: { code: string } }).error.code).toBe("PROOF_INVALID");
  });

  it("only lets one of two concurrent completions of the same challenge succeed (race-condition regression test)", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });
    const external = generateKeypair();

    const chRes = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
      keypair: agent,
      idempotencyKey: `ch:${Date.now()}`,
      body: { protocol: "agentpass_id", externalPublicKey: toBase64(external.publicKey), keyType: "ed25519" },
    });
    const { challengeId, challenge } = chRes.json as { challengeId: string; challenge: string };
    const proof = toBase64(sign(new Uint8Array(Buffer.from(challenge, "hex")), external.privateKey));

    const [a, b] = await Promise.all([
      call("POST", `/v1/agents/${agent.did}/link`, { keypair: agent, idempotencyKey: `link-a:${Date.now()}`, body: { protocol: "agentpass_id", value: "agentpass:race-a", challengeId, proofSignature: proof } }),
      call("POST", `/v1/agents/${agent.did}/link`, { keypair: agent, idempotencyKey: `link-b:${Date.now()}`, body: { protocol: "agentpass_id", value: "agentpass:race-b", challengeId, proofSignature: proof } }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("a2a_endpoint still links without a challenge; key-derived protocols reject the shortcut", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });

    const a2aRes = await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link-a2a:${Date.now()}`,
      body: { protocol: "a2a_endpoint", value: "https://agent.example/a2a" },
    });
    expect(a2aRes.status).toBe(200);
    expect((a2aRes.json as { linked: { a2a_endpoint?: string } }).linked.a2a_endpoint).toBe("https://agent.example/a2a");

    const shortcutRes = await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link-shortcut:${Date.now()}`,
      body: { protocol: "agentpass_id", value: "agentpass:shortcut" },
    });
    expect(shortcutRes.status).toBe(400);
    expect((shortcutRes.json as { error: { code: string } }).error.code).toBe("CHALLENGE_REQUIRED");
  });

  it("records per-link assurance in linkedProof, exposed via GET /protocols (audit #9)", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });
    const external = generateKeypair();
    const extKeyB64 = toBase64(external.publicKey);

    await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link-a2a:${Date.now()}`,
      body: { protocol: "a2a_endpoint", value: "https://agent.example/a2a" },
    });

    const chRes = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
      keypair: agent,
      idempotencyKey: `ch:${Date.now()}`,
      body: { protocol: "agentpass_id", externalPublicKey: extKeyB64, keyType: "ed25519" },
    });
    const { challengeId, challenge } = chRes.json as { challengeId: string; challenge: string };
    const proof = toBase64(sign(new Uint8Array(Buffer.from(challenge, "hex")), external.privateKey));
    const linkRes = await call("POST", `/v1/agents/${agent.did}/link`, {
      keypair: agent,
      idempotencyKey: `link:${challengeId}`,
      body: { protocol: "agentpass_id", value: "agentpass:x", challengeId, proofSignature: proof },
    });
    const linkProof = (linkRes.json as { linkedProof: Record<string, { method: string; externalPublicKey?: string }> }).linkedProof;
    expect(linkProof.agentpass_id).toMatchObject({ method: "key_possession", keyType: "ed25519", externalPublicKey: extKeyB64 });

    const protoRes = await call("GET", `/v1/agents/${agent.did}/protocols`);
    const lp = (protoRes.json as { linkedProof: Record<string, { method: string }> }).linkedProof;
    expect(lp.a2a_endpoint.method).toBe("unverified_claim");
    expect(lp.agentpass_id.method).toBe("key_possession");
  });
});

describe("agent identity revocation (SPEC.md §2.2, audit #10)", () => {
  it("revokes a self-signed ID and then blocks every further signed op", async () => {
    const kp = generateKeypair();
    await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `reg:${kp.did}`, body: { capabilities: ["job.posting"] } });

    const rev = await call("POST", `/v1/agents/${kp.did}/revoke`, { keypair: kp, idempotencyKey: `rev:${kp.did}`, body: { reason: "key compromised" } });
    expect(rev.status).toBe(200);
    expect((rev.json as { revokedAt: string }).revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const job = await call("POST", "/v1/jobs", { keypair: kp, idempotencyKey: `job:${Date.now()}`, body: { capability: "x", specHash: "sha256:s" } });
    expect(job.status).toBe(403);
    expect((job.json as { error: { code: string } }).error.code).toBe("AGENT_REVOKED");

    const again = await call("POST", `/v1/agents/${kp.did}/revoke`, { keypair: kp, idempotencyKey: `rev2:${kp.did}`, body: { reason: "again" } });
    expect(again.status).toBe(403);
  });

  it("excludes a revoked agent from search (unless include_revoked) and flags it in reputation", async () => {
    const kp = generateKeypair();
    const cap = `cap-${Math.random().toString(36).slice(2)}`;
    await call("POST", "/v1/agents", { keypair: kp, idempotencyKey: `reg:${kp.did}`, body: { capabilities: [cap] } });
    await call("POST", `/v1/agents/${kp.did}/revoke`, { keypair: kp, idempotencyKey: `rev:${kp.did}`, body: { reason: "rotating off" } });

    const plain = (await call("GET", `/v1/agents/search?capability=${cap}`)).json as { agents: { id: string }[] };
    expect(plain.agents.some((a) => a.id === kp.did)).toBe(false);
    const incl = (await call("GET", `/v1/agents/search?capability=${cap}&include_revoked=true`)).json as { agents: { id: string }[] };
    expect(incl.agents.some((a) => a.id === kp.did)).toBe(true);

    const rep = (await call("GET", `/v1/agents/${kp.did}/reputation`)).json as { flags: string[] };
    expect(rep.flags).toContain("revoked");
  });

  it("rejects revoking someone else's ID", async () => {
    const a = generateKeypair();
    const b = generateKeypair();
    await call("POST", "/v1/agents", { keypair: a, idempotencyKey: `reg:${a.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: b, idempotencyKey: `reg:${b.did}`, body: { capabilities: ["x"] } });
    const res = await call("POST", `/v1/agents/${b.did}/revoke`, { keypair: a, idempotencyKey: `rev-other:${Date.now()}`, body: { reason: "not mine" } });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe("NOT_SUBJECT_AGENT");
  });
});

describe("dispute + job state machine (SPEC.md §3.2/§4.3, audit #11)", () => {
  async function finalize(requester: Keypair, worker_: Keypair, jobId = `job_${Math.random().toString(36).slice(2)}`) {
    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");
    const input = job({ jobId });
    const content = buildSignableContent(requester.did, worker_.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), worker_.privateKey));
    const draftRes = await call("POST", "/v1/receipts", { keypair: worker_, idempotencyKey: `r:${jobId}`, body: { ...input, agentAId: requester.did, signature: draftSig } });
    const draft = draftRes.json as { receiptId: string };
    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), requester.privateKey));
    const fin = await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, { keypair: requester, idempotencyKey: `cs:${draft.receiptId}`, body: { signature: counterSig } });
    return (fin.json as { receiptId: string }).receiptId;
  }

  it("resolves a dispute (disputed -> finalized) via the opener, once per lifetime", async () => {
    const requester = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });
    const rid = await finalize(requester, worker_);

    await call("POST", `/v1/receipts/${encodeURIComponent(rid)}/dispute`, { keypair: requester, idempotencyKey: `d:${rid}`, body: { reason: "bad output" } });
    expect(((await call("GET", `/v1/agents/${worker_.did}/reputation`)).json as { flags: string[] }).flags).toContain("in_dispute");

    // disputed-against party can't resolve
    const wrong = await call("POST", `/v1/receipts/${encodeURIComponent(rid)}/dispute/resolve`, { keypair: worker_, idempotencyKey: `dr-wrong:${rid}`, body: {} });
    expect(wrong.status).toBe(403);
    expect((wrong.json as { error: { code: string } }).error.code).toBe("NOT_DISPUTE_OPENER");

    const resolved = await call("POST", `/v1/receipts/${encodeURIComponent(rid)}/dispute/resolve`, { keypair: requester, idempotencyKey: `dr:${rid}`, body: { note: "settled" } });
    expect(resolved.status).toBe(200);
    expect((resolved.json as { status: string; dispute: { status: string } }).status).toBe("finalized");
    expect((resolved.json as { dispute: { status: string } }).dispute.status).toBe("resolved");
    expect(((await call("GET", `/v1/agents/${worker_.did}/reputation`)).json as { flags: string[] }).flags).not.toContain("in_dispute");

    // no re-dispute
    const redispute = await call("POST", `/v1/receipts/${encodeURIComponent(rid)}/dispute`, { keypair: requester, idempotencyKey: `d2:${rid}`, body: { reason: "again" } });
    expect(redispute.status).toBe(409);
    expect((redispute.json as { error: { code: string } }).error.code).toBe("DISPUTE_ALREADY_RESOLVED");
  });

  it("rejects an offer on a job past its expiresAt", async () => {
    const poster = generateKeypair();
    const worker_ = generateKeypair();
    await call("POST", "/v1/agents", { keypair: poster, idempotencyKey: `reg:${poster.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: worker_, idempotencyKey: `reg:${worker_.did}`, body: { capabilities: ["x"] } });

    const past = new Date(Date.now() - 60_000).toISOString();
    const jobRes = await call("POST", "/v1/jobs", { keypair: poster, idempotencyKey: `j:${Date.now()}`, body: { capability: "x", specHash: "sha256:s", expiresAt: past } });
    const jobId = (jobRes.json as { jobId: string }).jobId;

    const offer = await call("POST", `/v1/jobs/${jobId}/offers`, { keypair: worker_, idempotencyKey: `o:${Date.now()}`, body: {} });
    expect(offer.status).toBe(409);
    expect((offer.json as { error: { code: string } }).error.code).toBe("JOB_EXPIRED");
  });
});

describe("independent verification (SPEC.md §12)", () => {
  async function finalizeReceipt(requester: Keypair, provider: Keypair) {
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: provider, idempotencyKey: `reg:${provider.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    const input = job();
    const content = buildSignableContent(requester.did, provider.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
    const draftRes = await call("POST", "/v1/receipts", {
      keypair: provider,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    const draft = draftRes.json as { receiptId: string; result: { outputHash: string } };

    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), requester.privateKey));
    const finalizedRes = await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
      keypair: requester,
      idempotencyKey: `countersign:${draft.receiptId}`,
      body: { signature: counterSig },
    });
    return finalizedRes.json as { receiptId: string; jobId: string; result: { outputHash: string } };
  }

  async function signVerification(
    verifierKeys: Keypair,
    input: { receiptId: string; jobId: string; provider: string; verifier: string; method: string; outputHash: string; result: string },
  ) {
    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableVerificationContent } = await import("../../sdk-js/src/core/verificationContent.js");
    const content = buildSignableVerificationContent(input as never);
    const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), verifierKeys.privateKey));
    return { content, signature };
  }

  it("verifies a finalized receipt and boosts the provider's reputation", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const before = await call("GET", `/v1/agents/${provider.did}/reputation`);
    expect((before.json as { components: { attestedReceipts: number } }).components.attestedReceipts).toBe(0);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const submitRes = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(submitRes.status).toBe(201);
    const record = submitRes.json as { verificationId: string; provider: string };
    expect(record.provider).toBe(provider.did);

    const getRes = await call("GET", `/v1/verifications/${encodeURIComponent(record.verificationId)}`);
    expect((getRes.json as { result: string }).result).toBe("verified");

    const listRes = await call("GET", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/verifications`);
    expect((listRes.json as { verifications: unknown[] }).verifications).toHaveLength(1);

    const after = await call("GET", `/v1/agents/${provider.did}/reputation`);
    const afterComponents = (after.json as { trustScore: number; components: { attestedReceipts: number } }).components;
    expect(afterComponents.attestedReceipts).toBe(1);
    expect((after.json as { trustScore: number }).trustScore).toBeGreaterThan((before.json as { trustScore: number }).trustScore);
  });

  it("rejects self-verification", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: provider.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(provider, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: provider,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: provider.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("SELF_VERIFICATION");
  });

  it("rejects the requester naming itself as verifier (not just the provider)", async () => {
    // An external audit found only the provider (agentB) was blocked from
    // self-verifying -- the requester (agentA), who already approved this
    // work by countersigning it, could name itself as the "independent"
    // verifier with no check at all.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: requester.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(requester, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: requester,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: requester.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("SELF_VERIFICATION");
  });

  it("rejects a verifier that isn't a registered agent", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const unregisteredVerifier = generateKeypair(); // deliberately never registered
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: unregisteredVerifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(unregisteredVerifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: unregisteredVerifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: unregisteredVerifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(404);
    expect((res.json as { error: { code: string } }).error.code).toBe("AGENT_NOT_FOUND");
  });

  it("rejects a second, different decision from a verifier who already decided this receipt", async () => {
    // Without this, the same verifier could submit "verified" and then,
    // separately, "rejected" (different content -> different
    // verificationId, so DUPLICATE_VERIFICATION's content-hash check
    // doesn't catch it) for the same receipt, leaving both as live records
    // with no way to tell which is authoritative.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const firstInput = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const first = await signVerification(verifier, firstInput);
    await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}-1`,
      body: { receiptId: firstInput.receiptId, verifier: verifier.did, method: firstInput.method, outputHash: firstInput.outputHash, result: firstInput.result, signature: first.signature },
    });

    const secondInput = { ...firstInput, result: "rejected" };
    const second = await signVerification(verifier, secondInput);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}-2`,
      body: { receiptId: secondInput.receiptId, verifier: verifier.did, method: secondInput.method, outputHash: secondInput.outputHash, result: secondInput.result, signature: second.signature },
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("VERIFIER_ALREADY_DECIDED");
  });

  it("rejects verifying a receipt that is still a draft", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: provider, idempotencyKey: `reg:${provider.did}`, body: { capabilities: ["x"] } });
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");
    const input = job();
    const content = buildSignableContent(requester.did, provider.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
    const draftRes = await call("POST", "/v1/receipts", {
      keypair: provider,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    const draft = draftRes.json as { receiptId: string; jobId: string; result: { outputHash: string } };

    const verInput = { receiptId: draft.receiptId, jobId: draft.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: draft.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, verInput);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: verInput.receiptId, verifier: verifier.did, method: verInput.method, outputHash: verInput.outputHash, result: verInput.result, signature },
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("RECEIPT_NOT_FINALIZED");
  });

  it("rejects an outputHash that doesn't match the receipt", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: "sha256:not_the_real_output", result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("VERIFICATION_TARGET_MISMATCH");
  });

  it("rejects a request not signed by the named verifier", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    const impostor = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    await call("POST", "/v1/agents", { keypair: impostor, idempotencyKey: `reg:${impostor.did}`, body: { capabilities: ["verification"] } });
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: impostor,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe("NOT_VERIFIER");
  });

  it("rejects a forged signature", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    const impostor = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(impostor, input); // signed by the wrong key
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("INVALID_VERIFICATION_SIGNATURE");
  });

  it("rejects an out-of-enum result and out-of-range score (the exact audit repro)", async () => {
    // The concrete case an external audit found live: a signed
    // POST /v1/verifications with { "result": "banana", "score": 999 } used
    // to be accepted by the Worker (only field *presence* was checked) while
    // the Node reference server correctly rejected it (Zod: result must be
    // "verified"|"rejected", score must be 0..1) -- the exact "same request,
    // different behavior" gap request-schema parity closes.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "agent_attestation", outputHash: receipt.result.outputHash, result: "banana", score: 999 };
    const { signature } = await signVerification(verifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, score: input.score, signature },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unsupported method at the HTTP layer with VALIDATION_ERROR", async () => {
    // Before request-schema parity was added (sdk-js/src/core/schemas.ts,
    // shared with the Node reference server), the Worker's POST /v1/verifications
    // handler only checked that `method` was *present*, so an out-of-enum value
    // reached verificationService's own SUPPORTED_METHODS check and surfaced as
    // UNSUPPORTED_VERIFICATION_METHOD. Now submitVerificationSchema's
    // `z.enum([...])` rejects it before the service is ever called -- matching
    // the Node reference server, which has always validated this the same way
    // (its own equivalent service-level check is exercised by a direct,
    // schema-bypassing unit test instead: tests/verificationFlow.test.ts's
    // "rejects an unsupported method"). The service-level check stays in place
    // in both runtimes as a defensive backstop for any caller that reaches it
    // without going through HTTP validation.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "tee_attestation", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects resubmitting byte-identical content", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const body = { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature };
    await call("POST", "/v1/verifications", { keypair: verifier, idempotencyKey: `verify-a:${Date.now()}`, body });
    const res = await call("POST", "/v1/verifications", { keypair: verifier, idempotencyKey: `verify-b:${Date.now()}`, body });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("DUPLICATE_VERIFICATION");
  });

  it("records a rejected verification without any reputation boost", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "agent_attestation", outputHash: receipt.result.outputHash, result: "rejected" };
    const { signature } = await signVerification(verifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect((res.json as { result: string }).result).toBe("rejected");

    const rep = await call("GET", `/v1/agents/${provider.did}/reputation`);
    expect((rep.json as { components: { attestedReceipts: number } }).components.attestedReceipts).toBe(0);
  });

  it("does not let a verified attestation resurrect a since-disputed receipt's reputation contribution", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const submitRes = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    const verificationId = (submitRes.json as { verificationId: string }).verificationId;

    const before = await call("GET", `/v1/agents/${provider.did}/reputation`);
    expect((before.json as { components: { attestedReceipts: number } }).components.attestedReceipts).toBe(1);

    const disputeRes = await call("POST", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/dispute`, {
      keypair: requester,
      idempotencyKey: `dispute:${Date.now()}`,
      body: { reason: "output did not match what was agreed" },
    });
    expect(disputeRes.status).toBe(200);

    const after = await call("GET", `/v1/agents/${provider.did}/reputation`);
    const afterJson = after.json as { components: { attestedReceipts: number }; flags: string[] };
    expect(afterJson.components.attestedReceipts).toBe(0);
    expect(afterJson.flags).toContain("in_dispute");

    // The Verification record itself is untouched — still queryable evidence.
    const verGet = await call("GET", `/v1/verifications/${encodeURIComponent(verificationId)}`);
    expect((verGet.json as { result: string }).result).toBe("verified");
  });

  it("does not let a minority 'verified' outvote a majority of independent 'rejected' verifications", async () => {
    // An audit found the old rule (`.some(v => v.result === "verified")`)
    // let exactly one `verified` record grant the reputation boost no
    // matter how many *different* verifiers independently rejected the same
    // receipt -- 1 verified + 9 rejected still counted as attested. This is
    // a real exploit for the receipt's own parties (get one colluding or
    // careless verifier to say "verified"), not a missing feature.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifiers = [generateKeypair(), generateKeypair(), generateKeypair()];
    for (const v of verifiers) {
      await call("POST", "/v1/agents", { keypair: v, idempotencyKey: `reg:${v.did}`, body: { capabilities: ["verification"] } });
      await authorizeVerifier(v);
    }
    const receipt = await finalizeReceipt(requester, provider);

    const results = ["verified", "rejected", "rejected"];
    for (let i = 0; i < verifiers.length; i++) {
      const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifiers[i].did, method: "agent_attestation", outputHash: receipt.result.outputHash, result: results[i] };
      const { signature } = await signVerification(verifiers[i], input);
      await call("POST", "/v1/verifications", {
        keypair: verifiers[i],
        idempotencyKey: `verify:${Date.now()}-${i}`,
        body: { receiptId: input.receiptId, verifier: verifiers[i].did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
      });
    }

    const listRes = await call("GET", `/v1/receipts/${encodeURIComponent(receipt.receiptId)}/verifications`);
    expect((listRes.json as { verifications: unknown[] }).verifications).toHaveLength(3);

    // 1 verified vs. 2 rejected: no attestation boost, despite a `verified`
    // record existing.
    const rep = await call("GET", `/v1/agents/${provider.did}/reputation`);
    expect((rep.json as { components: { attestedReceipts: number } }).components.attestedReceipts).toBe(0);
  });

  it("still attests on the ordinary, common case: one verifier, verified, zero rejections", async () => {
    // Explicit non-regression check: the fix above must not raise the bar
    // for the overwhelmingly common single-verifier case.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });

    const rep = await call("GET", `/v1/agents/${provider.did}/reputation`);
    expect((rep.json as { components: { attestedReceipts: number } }).components.attestedReceipts).toBe(1);
  });

  it("rejects a verifier that is registered but not operator-authorized", async () => {
    // The core fix: a receipt's own audit was right that "any registered
    // agent" was never a real independence guarantee -- anyone could
    // self-register and immediately verify. Only the operator-only
    // POST /agents/:id/verifier-status may flip isAuthorizedVerifier.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const unauthorizedVerifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: unauthorizedVerifier, idempotencyKey: `reg:${unauthorizedVerifier.did}`, body: { capabilities: ["verification"] } }); // registered, never authorized
    const receipt = await finalizeReceipt(requester, provider);

    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: unauthorizedVerifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(unauthorizedVerifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: unauthorizedVerifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: unauthorizedVerifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe("VERIFIER_NOT_AUTHORIZED");
  });

  it("rejects a non-operator trying to grant verifier status", async () => {
    const impostor = generateKeypair();
    const target = generateKeypair();
    await call("POST", "/v1/agents", { keypair: target, idempotencyKey: `reg:${target.did}`, body: { capabilities: ["verification"] } });

    const res = await call("POST", `/v1/agents/${encodeURIComponent(target.did)}/verifier-status`, {
      keypair: impostor,
      idempotencyKey: `authorize:${Date.now()}`,
      body: { authorized: true },
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe("NOT_OPERATOR");

    // Confirmed still unauthorized -- the impostor's call had no effect.
    const requester = generateKeypair();
    const provider = generateKeypair();
    const receipt = await finalizeReceipt(requester, provider);
    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: target.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(target, input);
    const verifyRes = await call("POST", "/v1/verifications", {
      keypair: target,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: target.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(verifyRes.status).toBe(403);
    expect((verifyRes.json as { error: { code: string } }).error.code).toBe("VERIFIER_NOT_AUTHORIZED");
  });

  it("lets the operator revoke a previously-granted verifier status", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    const verifier = generateKeypair();
    await call("POST", "/v1/agents", { keypair: verifier, idempotencyKey: `reg:${verifier.did}`, body: { capabilities: ["verification"] } });
    await authorizeVerifier(verifier);
    const revokeRes = await call("POST", `/v1/agents/${encodeURIComponent(verifier.did)}/verifier-status`, {
      keypair: testOperatorKeypair,
      idempotencyKey: `revoke:${Date.now()}`,
      body: { authorized: false },
    });
    expect(revokeRes.status).toBe(200);
    expect((revokeRes.json as { isAuthorizedVerifier: boolean }).isAuthorizedVerifier).toBe(false);

    const receipt = await finalizeReceipt(requester, provider);
    const input = { receiptId: receipt.receiptId, jobId: receipt.jobId, provider: provider.did, verifier: verifier.did, method: "deterministic", outputHash: receipt.result.outputHash, result: "verified" };
    const { signature } = await signVerification(verifier, input);
    const res = await call("POST", "/v1/verifications", {
      keypair: verifier,
      idempotencyKey: `verify:${Date.now()}`,
      body: { receiptId: input.receiptId, verifier: verifier.did, method: input.method, outputHash: input.outputHash, result: input.result, signature },
    });
    expect(res.status).toBe(403);
    expect((res.json as { error: { code: string } }).error.code).toBe("VERIFIER_NOT_AUTHORIZED");
  });
});

describe("reputation badge (GET /agents/:id/badge.svg, /badge.json)", () => {
  async function finalizeReceipt(requester: Keypair, provider: Keypair) {
    await call("POST", "/v1/agents", { keypair: requester, idempotencyKey: `reg:${requester.did}`, body: { capabilities: ["job.posting"] } });
    await call("POST", "/v1/agents", { keypair: provider, idempotencyKey: `reg:${provider.did}`, body: { capabilities: ["x"] } });

    const { canonicalize } = await import("../../sdk-js/src/crypto/canonical.js");
    const { buildSignableContent } = await import("../../sdk-js/src/core/receiptContent.js");

    const input = job();
    const content = buildSignableContent(requester.did, provider.did, input);
    const draftSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined })), provider.privateKey));
    const draftRes = await call("POST", "/v1/receipts", {
      keypair: provider,
      idempotencyKey: `receipt:${input.jobId}`,
      body: { ...input, agentAId: requester.did, signature: draftSig },
    });
    const draft = draftRes.json as { receiptId: string };

    const counterSig = toBase64(sign(new TextEncoder().encode(canonicalize({ ...content, dispute: undefined, receiptId: draft.receiptId })), requester.privateKey));
    await call("POST", `/v1/receipts/${encodeURIComponent(draft.receiptId)}/countersign`, {
      keypair: requester,
      idempotencyKey: `countersign:${draft.receiptId}`,
      body: { signature: counterSig },
    });
  }

  it("renders a color-coded SVG badge for an agent with real reputation history", async () => {
    const requester = generateKeypair();
    const provider = generateKeypair();
    await finalizeReceipt(requester, provider);

    const rep = await call("GET", `/v1/agents/${encodeURIComponent(provider.did)}/reputation`);
    const { trustScore, components } = rep.json as { trustScore: number; components: { verifiedReceipts: number } };
    expect(components.verifiedReceipts).toBe(1);

    const badge = await callRaw(`/v1/agents/${encodeURIComponent(provider.did)}/badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(badge.headers.get("access-control-allow-origin")).toBe("*");
    expect(badge.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(badge.text).toContain("<svg");
    expect(badge.text).toContain(">inam<");
    // Score formatting matches computeReputation()'s own rounding, and a real,
    // earned history means this is NOT the neutral "new" grey badge.
    const expectedValue = Number.isInteger(trustScore) ? String(trustScore) : trustScore.toFixed(1);
    expect(badge.text).toContain(`>${expectedValue}<`);
    expect(badge.text).not.toContain(">new<");
    expect(badge.text).not.toContain(">unknown<");
  });

  it("renders a distinct neutral grey badge for a brand-new agent with zero receipt history", async () => {
    const fresh = generateKeypair();
    await call("POST", "/v1/agents", { keypair: fresh, idempotencyKey: `reg:${fresh.did}`, body: { capabilities: ["x"] } });

    const badge = await callRaw(`/v1/agents/${encodeURIComponent(fresh.did)}/badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.text).toContain(">new<");
    expect(badge.text).toContain("#9f9f9f"); // neutral grey, not a red/orange "penalized" color

    const badgeJson = await call("GET", `/v1/agents/${encodeURIComponent(fresh.did)}/badge.json`);
    expect(badgeJson.status).toBe(200);
    expect(badgeJson.json).toMatchObject({ schemaVersion: 1, label: "inam", message: "new", status: "new" });
  });

  it("renders a graceful unknown-state badge for an unregistered did:key instead of a 404/broken image", async () => {
    const unknownDid = "did:key:z6MkNoSuchAgentEverRegisteredHere00000000000";

    // The underlying JSON route still 404s — badge.svg deliberately doesn't.
    const rep = await call("GET", `/v1/agents/${encodeURIComponent(unknownDid)}/reputation`);
    expect(rep.status).toBe(404);

    const badge = await callRaw(`/v1/agents/${encodeURIComponent(unknownDid)}/badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(badge.text).toContain("<svg");
    expect(badge.text).toContain(">unknown<");

    const badgeJson = await call("GET", `/v1/agents/${encodeURIComponent(unknownDid)}/badge.json`);
    expect(badgeJson.status).toBe(200);
    expect(badgeJson.json).toMatchObject({ schemaVersion: 1, label: "inam", message: "unknown", status: "not_found" });
  });

  it("never interpolates agent-supplied metadata into the badge", async () => {
    const agent = generateKeypair();
    await call("POST", "/v1/agents", {
      keypair: agent,
      idempotencyKey: `reg:${agent.did}`,
      body: { capabilities: ["x"], metadata: { name: '<script>alert(1)</script>&"malicious"' } },
    });

    const badge = await callRaw(`/v1/agents/${encodeURIComponent(agent.did)}/badge.svg`);
    expect(badge.status).toBe(200);
    expect(badge.text).not.toContain("<script>");
    expect(badge.text).not.toContain("malicious");
  });
});
