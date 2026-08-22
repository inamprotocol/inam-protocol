import * as ed25519 from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";

// @noble/ed25519 v2 needs a sha512 implementation wired in for the sync API.
ed25519.etc.sha512Sync = (...msgs: Uint8Array[]) =>
  sha512(ed25519.etc.concatBytes(...msgs));

// multicodec value for ed25519-pub (0xed) as a varint: [0xed, 0x01].
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

export interface Keypair {
  did: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function publicKeyToDid(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return "did:key:z" + bs58.encode(prefixed);
}

export function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`Unsupported DID method: ${did}`);
  }
  const decoded = bs58.decode(did.slice("did:key:z".length));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new Error(`Unsupported key type in DID: ${did}`);
  }
  return decoded.slice(2);
}

export function generateKeypair(): Keypair {
  return keypairFromPrivateKey(ed25519.utils.randomPrivateKey());
}

export function keypairFromPrivateKey(privateKey: Uint8Array): Keypair {
  const publicKey = ed25519.getPublicKey(privateKey);
  return { did: publicKeyToDid(publicKey), publicKey, privateKey };
}

export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(signature: Uint8Array, message: Uint8Array, did: string): boolean {
  try {
    const publicKey = didToPublicKey(did);
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Verifies against a raw Ed25519 public key rather than a did:key — for
 * externally-issued identities (e.g. an AgentPass/AITP key) that aren't
 * necessarily encoded as an INAM did:key. */
export function verifyRawEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return Buffer.from(sha256(bytes)).toString("hex");
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
