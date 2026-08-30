import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { generateKeypair, sha256Hex, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";

// Audit #8: the signed-request string is METHOD\npath\ntimestamp\nsha256(body)
// -- it does NOT cover the Idempotency-Key. So a captured signed request can
// be replayed with a fresh Idempotency-Key: the signature still verifies, and
// the idempotency cache (keyed on the fresh key) misses, so the handler runs
// a second time. The replay guard binds each verified signature to the single
// key it was first seen with.
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

async function register(kp: ReturnType<typeof generateKeypair>, capabilities = ["job.posting"]) {
  const body = JSON.stringify({ capabilities });
  await fetch(`${baseUrl}/v1/agents`, {
    method: "POST",
    headers: { ...signedHeaders(kp, "POST", "/v1/agents", body), "idempotency-key": `reg:${kp.did}` },
    body,
  });
}

async function signedPost(kp: ReturnType<typeof generateKeypair>, path: string, payload: unknown, idempotencyKey: string) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...signedHeaders(kp, "POST", path, body), "idempotency-key": idempotencyKey },
    body,
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}

describe("signature replay guard", () => {
  it("rejects a captured request replayed with a different Idempotency-Key, but still replays it verbatim", async () => {
    const kp = generateKeypair();
    await register(kp);

    const body = JSON.stringify({ capability: "translation.tr-en", specHash: "sha256:replay_spec" });
    const headers = signedHeaders(kp, "POST", "/v1/jobs", body);

    const first = await fetch(`${baseUrl}/v1/jobs`, { method: "POST", headers: { ...headers, "idempotency-key": "key-A" }, body });
    expect(first.status).toBe(201);
    const firstJob = (await first.json()) as { jobId: string };

    // Same signature + timestamp, fresh key -> replay attempt.
    const replay = await fetch(`${baseUrl}/v1/jobs`, { method: "POST", headers: { ...headers, "idempotency-key": "key-B" }, body });
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe("REPLAYED_REQUEST");

    // Exact same request again (same key) -> idempotent replay of the cached
    // response, not a second job.
    const verbatim = await fetch(`${baseUrl}/v1/jobs`, { method: "POST", headers: { ...headers, "idempotency-key": "key-A" }, body });
    expect(verbatim.status).toBe(201);
    expect(((await verbatim.json()) as { jobId: string }).jobId).toBe(firstJob.jobId);
  });

  it("does not cache a non-2xx response — a fresh signed retry with the same key re-executes and can now succeed", async () => {
    const poster = generateKeypair();
    const worker = generateKeypair();
    await register(poster);
    await register(worker, ["translation.tr-en"]);

    const job = await signedPost(poster, "/v1/jobs", { capability: "translation.tr-en", specHash: "sha256:retry_spec" }, `job:${Date.now()}`);
    const jobId = job.json!.jobId as string;

    // Accept before any offer exists -> 400 OFFER_NOT_FOUND. If this response
    // were cached under the idempotency key, the retry below would replay it.
    const acceptKey = `accept:${jobId}`;
    const early = await signedPost(poster, `/v1/jobs/${jobId}/accept`, { agentId: worker.did }, acceptKey);
    expect(early.status).toBe(400);
    expect(early.json!.error).toMatchObject({ code: "OFFER_NOT_FOUND" });

    await signedPost(worker, `/v1/jobs/${jobId}/offers`, { message: "on it" }, `offer:${jobId}`);

    // Same idempotency key, fresh signature: the earlier 400 was not cached,
    // so this re-executes against the now-changed state and succeeds.
    const accepted = await signedPost(poster, `/v1/jobs/${jobId}/accept`, { agentId: worker.did }, acceptKey);
    expect(accepted.status).toBe(200);
    expect(accepted.json!.status).toBe("accepted");
  });
});
