import { describe, expect, it } from "vitest";
import { generateKeypair, sign as ed25519Sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { generateP256Keypair, p256Sign } from "../sdk-js/src/crypto/p256.js";
import { registerAgent, requestLinkChallenge, completeLink, linkEndpoint } from "../src/services/agentService.js";
import { ApiError } from "../src/middleware/errors.js";

async function expectApiError(fn: () => unknown, code: string) {
  try {
    await fn();
    throw new Error(`expected ApiError ${code} but nothing was thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

describe("external identity link challenges", () => {
  it("links agentpass_id after a valid Ed25519 challenge signature", () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateKeypair(); // reuse INAM's own Ed25519 keypair generator as a stand-in external key

    const challenge = requestLinkChallenge(agent.did, "agentpass_id", toBase64(external.publicKey), "ed25519");
    expect(challenge.challengeId).toBeTruthy();
    expect(challenge.challenge).toMatch(/^[0-9a-f]{64}$/);

    const proof = toBase64(ed25519Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    const updated = completeLink(agent.did, "agentpass_id", "agentpass:abc123", challenge.challengeId, proof);
    expect(updated.linked.agentpass_id).toBe("agentpass:abc123");
  });

  it("links passport_id after a valid P-256 challenge signature (ATTP's primary curve)", () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateP256Keypair();

    const challenge = requestLinkChallenge(agent.did, "passport_id", toBase64(external.publicKey), "p256");
    const proof = toBase64(p256Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    const updated = completeLink(agent.did, "passport_id", "passport:xyz", challenge.challengeId, proof);
    expect(updated.linked.passport_id).toBe("passport:xyz");
  });

  it("rejects a signature from the wrong external key", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateKeypair();
    const impostor = generateKeypair();

    const challenge = requestLinkChallenge(agent.did, "aitp_id", toBase64(external.publicKey), "ed25519");
    const proof = toBase64(ed25519Sign(Buffer.from(challenge.challenge, "hex"), impostor.privateKey));
    await expectApiError(() => completeLink(agent.did, "aitp_id", "aitp:1", challenge.challengeId, proof), "PROOF_INVALID");
  });

  it("rejects reusing an already-consumed challenge", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateKeypair();

    const challenge = requestLinkChallenge(agent.did, "agentpass_id", toBase64(external.publicKey), "ed25519");
    const proof = toBase64(ed25519Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    completeLink(agent.did, "agentpass_id", "agentpass:once", challenge.challengeId, proof);

    await expectApiError(() => completeLink(agent.did, "agentpass_id", "agentpass:twice", challenge.challengeId, proof), "CHALLENGE_ALREADY_USED");
  });

  it("rejects a challenge issued for a different protocol", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateKeypair();

    const challenge = requestLinkChallenge(agent.did, "agentpass_id", toBase64(external.publicKey), "ed25519");
    const proof = toBase64(ed25519Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    await expectApiError(() => completeLink(agent.did, "aitp_id", "aitp:1", challenge.challengeId, proof), "CHALLENGE_MISMATCH");
  });

  it("rejects an unknown challenge id", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    await expectApiError(() => completeLink(agent.did, "agentpass_id", "agentpass:1", "nonexistent-challenge-id", "invalid"), "CHALLENGE_NOT_FOUND");
  });

  it("still allows linking a2a_endpoint without a challenge, but refuses key-derived protocols on that path", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const updated = linkEndpoint(agent.did, "a2a_endpoint", "https://agent.example/a2a");
    expect(updated.linked.a2a_endpoint).toBe("https://agent.example/a2a");

    await expectApiError(() => linkEndpoint(agent.did, "agentpass_id", "agentpass:shortcut"), "CHALLENGE_REQUIRED");
  });

  it("rejects an unsupported key type", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    await expectApiError(() => requestLinkChallenge(agent.did, "agentpass_id", "aGVsbG8=", "rsa"), "UNSUPPORTED_KEY_TYPE");
  });

  it("records the assurance level of each link in linkedProof (audit #9)", () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateP256Keypair();
    const extKeyB64 = toBase64(external.publicKey);

    // a2a_endpoint — no external proof, just the INAM signature.
    let record = linkEndpoint(agent.did, "a2a_endpoint", "https://agent.example/a2a");
    expect(record.linkedProof.a2a_endpoint).toMatchObject({ method: "unverified_claim" });
    expect(record.linkedProof.a2a_endpoint?.externalPublicKey).toBeUndefined();
    expect(record.linkedProof.a2a_endpoint?.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // passport_id — challenge-verified: records method + the key that was proven.
    const challenge = requestLinkChallenge(agent.did, "passport_id", extKeyB64, "p256");
    const proof = toBase64(p256Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    record = completeLink(agent.did, "passport_id", "passport:xyz", challenge.challengeId, proof);
    expect(record.linkedProof.passport_id).toMatchObject({
      method: "key_possession",
      keyType: "p256",
      externalPublicKey: extKeyB64,
    });
    // the two links coexist with their own distinct assurance levels
    expect(record.linkedProof.a2a_endpoint?.method).toBe("unverified_claim");
    expect(record.linkedProof.passport_id?.method).toBe("key_possession");
  });
});
