import { p256 } from "@noble/curves/nist.js";

/**
 * ECDSA P-256, used alongside Ed25519 for external-identity challenge proofs
 * (SPEC.md's external-identity linking section) because it's the primary
 * curve mandated by ATTP (draft-sharif-attp-00, the trust-transport protocol
 * AgentPass is built on): "Each agent MUST have a unique ECDSA key pair using
 * the P-256 curve." Not used anywhere else in INAM — the protocol's own
 * did:key identity stays Ed25519-only.
 *
 * `p256.sign`/`p256.verify` already do standard ECDSA-with-SHA256 internally
 * (no manual pre-hashing needed) and return/accept the 64-byte compact r||s
 * encoding — this matches ATTP's wire format exactly: "signature =
 * ECDSA-Sign(SHA-256(challenge), agentPrivateKey)" with "IEEE P1363
 * fixed-length r||s encoding (64 bytes for P-256)".
 */

export interface P256Keypair {
  publicKey: Uint8Array; // SEC1 compressed, 33 bytes
  privateKey: Uint8Array; // 32 bytes
}

export function generateP256Keypair(): P256Keypair {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

export function p256Sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return p256.sign(message, privateKey);
}

export function p256Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return p256.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
