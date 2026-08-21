import { describe, expect, it } from "vitest";
import { generateKeypair, didToPublicKey, sign, verify } from "../src/crypto/keys.js";

describe("did:key round-trip and signing", () => {
  it("encodes a generated keypair as a did:key:z... that decodes back to the same public key", () => {
    const kp = generateKeypair();
    expect(kp.did.startsWith("did:key:z")).toBe(true);
    expect(didToPublicKey(kp.did)).toEqual(kp.publicKey);
  });

  it("verifies a signature made with the matching private key", () => {
    const kp = generateKeypair();
    const message = new TextEncoder().encode("hello inam");
    const sig = sign(message, kp.privateKey);
    expect(verify(sig, message, kp.did)).toBe(true);
  });

  it("rejects a signature if the message was tampered with", () => {
    const kp = generateKeypair();
    const sig = sign(new TextEncoder().encode("original"), kp.privateKey);
    expect(verify(sig, new TextEncoder().encode("tampered"), kp.did)).toBe(false);
  });

  it("rejects a signature made by a different agent's key", () => {
    const signer = generateKeypair();
    const impostor = generateKeypair();
    const message = new TextEncoder().encode("hello inam");
    const sig = sign(message, signer.privateKey);
    expect(verify(sig, message, impostor.did)).toBe(false);
  });
});
