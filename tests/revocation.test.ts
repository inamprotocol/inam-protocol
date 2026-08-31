import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { generateKeypair, sha256Hex, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";

// Audit #10: an INAM ID *is* its Ed25519 key -- a leaked key can't be
// re-pointed. POST /agents/:id/revoke is the one-way tombstone: after it, the
// ID performs no signed operations and drops out of search.
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

type KP = ReturnType<typeof generateKeypair>;

async function signedPost(kp: KP, path: string, payload: unknown, key: string) {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const sig = toBase64(sign(new TextEncoder().encode(`POST\n${path}\n${ts}\n${sha256Hex(body)}`), kp.privateKey));
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "inam-agent": kp.did, "inam-timestamp": ts, "inam-signature": sig, "idempotency-key": key },
    body,
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}
const register = (kp: KP, caps = ["job.posting"]) => signedPost(kp, "/v1/agents", { capabilities: caps }, `reg:${kp.did}`);

describe("agent identity revocation", () => {
  it("revokes a self-signed ID, then rejects every further signed op from it", async () => {
    const kp = generateKeypair();
    await register(kp);

    const rev = await signedPost(kp, `/v1/agents/${kp.did}/revoke`, { reason: "key suspected compromised" }, `rev:${kp.did}`);
    expect(rev.status).toBe(200);
    expect(rev.json!.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rev.json!.revocationReason).toBe("key suspected compromised");

    // any subsequent signed request -> 403 AGENT_REVOKED (enforced in the
    // signature middleware, so it covers every signed route)
    const job = await signedPost(kp, "/v1/jobs", { capability: "x", specHash: "sha256:s" }, `job:${Date.now()}`);
    expect(job.status).toBe(403);
    expect(job.json!.error).toMatchObject({ code: "AGENT_REVOKED" });

    // including a second revoke
    const again = await signedPost(kp, `/v1/agents/${kp.did}/revoke`, { reason: "again" }, `rev2:${kp.did}`);
    expect(again.status).toBe(403);
  });

  it("drops a revoked agent from search unless include_revoked=true, and flags it in reputation", async () => {
    const kp = generateKeypair();
    await register(kp, ["translation.rare-cap-xyz"]);
    await signedPost(kp, `/v1/agents/${kp.did}/revoke`, { reason: "rotating off" }, `rev:${kp.did}`);

    const plain = await (await fetch(`${baseUrl}/v1/agents/search?capability=translation.rare-cap-xyz`)).json() as { agents: { id: string }[] };
    expect(plain.agents.some((a) => a.id === kp.did)).toBe(false);

    const withRevoked = await (await fetch(`${baseUrl}/v1/agents/search?capability=translation.rare-cap-xyz&include_revoked=true`)).json() as { agents: { id: string }[] };
    expect(withRevoked.agents.some((a) => a.id === kp.did)).toBe(true);

    const rep = await (await fetch(`${baseUrl}/v1/agents/${kp.did}/reputation`)).json() as { flags: string[] };
    expect(rep.flags).toContain("revoked");

    // the record still reads back (it's a tombstone, not a delete)
    const rec = await (await fetch(`${baseUrl}/v1/agents/${kp.did}`)).json() as { revokedAt?: string };
    expect(rec.revokedAt).toBeTruthy();
  });

  it("rejects revoking someone else's ID", async () => {
    const a = generateKeypair();
    const b = generateKeypair();
    await register(a);
    await register(b);
    const res = await signedPost(a, `/v1/agents/${b.did}/revoke`, { reason: "not mine to revoke" }, `rev-other:${Date.now()}`);
    expect(res.status).toBe(403);
    expect(res.json!.error).toMatchObject({ code: "NOT_SUBJECT_AGENT" });
  });
});
