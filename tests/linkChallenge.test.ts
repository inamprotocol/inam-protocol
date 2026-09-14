import { describe, expect, it } from "vitest";
import { generateKeypair, sign as ed25519Sign, toBase64 } from "../sdk-js/src/crypto/keys.js";
import { generateP256Keypair, p256Sign } from "../sdk-js/src/crypto/p256.js";
import { generateSecp256k1Keypair, secp256k1Sign, ethAddressFromUncompressedPublicKey } from "../sdk-js/src/crypto/secp256k1.js";
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

  it("links erc8004_id after a valid secp256k1 challenge signature whose address matches the key (SPEC.md v0.18)", () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateSecp256k1Keypair();
    const address = ethAddressFromUncompressedPublicKey(external.publicKey);

    const challenge = requestLinkChallenge(agent.did, "erc8004_id", toBase64(external.publicKey), "secp256k1");
    const proof = toBase64(secp256k1Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    const updated = completeLink(agent.did, "erc8004_id", address, challenge.challengeId, proof);
    expect(updated.linked.erc8004_id).toBe(address);
    expect(updated.linkedProof.erc8004_id).toMatchObject({ method: "key_possession", keyType: "secp256k1" });
  });

  it("rejects erc8004_id when the claimed address doesn't match the proven key", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateSecp256k1Keypair();

    const challenge = requestLinkChallenge(agent.did, "erc8004_id", toBase64(external.publicKey), "secp256k1");
    const proof = toBase64(secp256k1Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey));
    await expectApiError(
      () => completeLink(agent.did, "erc8004_id", "0x0000000000000000000000000000000000dEaD", challenge.challengeId, proof),
      "ERC8004_ID_MISMATCH",
    );
  });

  it("rejects a high-S (non-canonical) secp256k1 signature", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateSecp256k1Keypair();
    const address = ethAddressFromUncompressedPublicKey(external.publicKey);

    const challenge = requestLinkChallenge(agent.did, "erc8004_id", toBase64(external.publicKey), "secp256k1");
    const sig = secp256k1Sign(Buffer.from(challenge.challenge, "hex"), external.privateKey);
    // Flip s to its high-S complement (n - s) — must be rejected, not silently accepted.
    const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
    const s = BigInt("0x" + Buffer.from(sig.slice(32)).toString("hex"));
    const highS = (SECP256K1_N - s).toString(16).padStart(64, "0");
    const tampered = Buffer.concat([Buffer.from(sig.slice(0, 32)), Buffer.from(highS, "hex")]);
    await expectApiError(() => completeLink(agent.did, "erc8004_id", address, challenge.challengeId, toBase64(tampered)), "PROOF_INVALID");
  });

  it("rejects pairing erc8004_id with a non-secp256k1 key type", async () => {
    const agent = generateKeypair();
    registerAgent(agent.did, { capabilities: ["x"] });
    const external = generateP256Keypair();
    await expectApiError(() => requestLinkChallenge(agent.did, "erc8004_id", toBase64(external.publicKey), "p256"), "UNSUPPORTED_KEY_TYPE");
  });

  it("derives the well-known Ethereum address for the point at private key 1 (real published vector, not just a round-trip)", () => {
    const Gx = BigInt("0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798");
    const Gy = BigInt("0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8");
    const toBytes32 = (n: bigint) => {
      const hex = n.toString(16).padStart(64, "0");
      return Uint8Array.from(Buffer.from(hex, "hex"));
    };
    const pub = new Uint8Array(65);
    pub[0] = 0x04;
    pub.set(toBytes32(Gx), 1);
    pub.set(toBytes32(Gy), 33);
    expect(ethAddressFromUncompressedPublicKey(pub)).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });
});
