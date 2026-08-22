import { generateKeypair, sha256Hex, sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { generateP256Keypair, p256Sign } from "../sdk-js/src/crypto/p256.js";
import type { Keypair } from "../sdk-js/src/crypto/keys.js";

/** Exercises the external-identity link challenge/response flow over real
 * HTTP — routing, zod validation, signed-request middleware, and idempotency
 * for the part of Phase 4 the unit tests only reach through the service
 * layer directly. */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function call(method: string, path: string, opts?: { body?: unknown; keypair?: Keypair; idempotencyKey?: string }) {
  const rawBody = opts?.body !== undefined ? JSON.stringify(opts.body) : "";
  const headers: Record<string, string> = { "content-type": "application/json" };
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
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: opts?.body !== undefined ? rawBody : undefined });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

async function main() {
  const agent = generateKeypair();
  await call("POST", "/v1/agents", { keypair: agent, idempotencyKey: `reg:${agent.did}`, body: { capabilities: ["x"] } });

  // --- Ed25519 external identity ---
  const externalEd = generateKeypair();
  const chRes = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
    keypair: agent,
    idempotencyKey: `ch:${Date.now()}`,
    body: { protocol: "agentpass_id", externalPublicKey: toBase64(externalEd.publicKey), keyType: "ed25519" },
  });
  check("challenge issued -> 201 with hex challenge", chRes.status === 201 && /^[0-9a-f]{64}$/.test((chRes.json as { challenge: string }).challenge));
  const { challengeId, challenge } = chRes.json as { challengeId: string; challenge: string };

  const proof = toBase64(sign(Buffer.from(challenge, "hex"), externalEd.privateKey));
  const linkRes = await call("POST", `/v1/agents/${agent.did}/link`, {
    keypair: agent,
    idempotencyKey: `link:${challengeId}`,
    body: { protocol: "agentpass_id", value: "agentpass:http-smoke", challengeId, proofSignature: proof },
  });
  check("link completes with valid Ed25519 proof", linkRes.status === 200 && (linkRes.json as { linked: { agentpass_id?: string } }).linked.agentpass_id === "agentpass:http-smoke");

  const replayRes = await call("POST", `/v1/agents/${agent.did}/link`, {
    keypair: agent,
    idempotencyKey: `link-replay:${Date.now()}`,
    body: { protocol: "agentpass_id", value: "agentpass:replay", challengeId, proofSignature: proof },
  });
  check("reusing the same challenge -> 409 CHALLENGE_ALREADY_USED", replayRes.status === 409 && (replayRes.json as { error: { code: string } }).error.code === "CHALLENGE_ALREADY_USED");

  // --- P-256 external identity (ATTP's primary curve) ---
  const externalP256 = generateP256Keypair();
  const chRes2 = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
    keypair: agent,
    idempotencyKey: `ch2:${Date.now()}`,
    body: { protocol: "passport_id", externalPublicKey: toBase64(externalP256.publicKey), keyType: "p256" },
  });
  const { challengeId: challengeId2, challenge: challenge2 } = chRes2.json as { challengeId: string; challenge: string };
  const proof2 = toBase64(p256Sign(Buffer.from(challenge2, "hex"), externalP256.privateKey));
  const linkRes2 = await call("POST", `/v1/agents/${agent.did}/link`, {
    keypair: agent,
    idempotencyKey: `link2:${challengeId2}`,
    body: { protocol: "passport_id", value: "passport:http-smoke", challengeId: challengeId2, proofSignature: proof2 },
  });
  check("link completes with valid P-256 proof", linkRes2.status === 200 && (linkRes2.json as { linked: { passport_id?: string } }).linked.passport_id === "passport:http-smoke");

  // --- wrong signature ---
  const chRes3 = await call("POST", `/v1/agents/${agent.did}/link/challenge`, {
    keypair: agent,
    idempotencyKey: `ch3:${Date.now()}`,
    body: { protocol: "aitp_id", externalPublicKey: toBase64(externalEd.publicKey), keyType: "ed25519" },
  });
  const { challengeId: challengeId3, challenge: challenge3 } = chRes3.json as { challengeId: string; challenge: string };
  const impostor = generateKeypair();
  const badProof = toBase64(sign(Buffer.from(challenge3, "hex"), impostor.privateKey));
  const badLinkRes = await call("POST", `/v1/agents/${agent.did}/link`, {
    keypair: agent,
    idempotencyKey: `link3:${challengeId3}`,
    body: { protocol: "aitp_id", value: "aitp:should-fail", challengeId: challengeId3, proofSignature: badProof },
  });
  check("wrong external key -> 400 PROOF_INVALID", badLinkRes.status === 400 && (badLinkRes.json as { error: { code: string } }).error.code === "PROOF_INVALID");

  // --- a2a_endpoint stays a plain unchecked claim ---
  const a2aRes = await call("POST", `/v1/agents/${agent.did}/link`, {
    keypair: agent,
    idempotencyKey: `link-a2a:${Date.now()}`,
    body: { protocol: "a2a_endpoint", value: "https://agent.example/a2a" },
  });
  check("a2a_endpoint links without a challenge", a2aRes.status === 200 && (a2aRes.json as { linked: { a2a_endpoint?: string } }).linked.a2a_endpoint === "https://agent.example/a2a");

  const shortcutRes = await call("POST", `/v1/agents/${agent.did}/link`, {
    keypair: agent,
    idempotencyKey: `link-shortcut:${Date.now()}`,
    body: { protocol: "agentpass_id", value: "agentpass:shortcut" },
  });
  check("key-derived protocol without a challenge -> 400 CHALLENGE_REQUIRED", shortcutRes.status === 400 && (shortcutRes.json as { error: { code: string } }).error.code === "CHALLENGE_REQUIRED");

  console.log(failures === 0 ? "\nAll link-challenge HTTP smoke checks passed." : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exitCode = 1;
});
