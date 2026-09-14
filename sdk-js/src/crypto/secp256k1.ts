import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { toHex } from "./keys.js";

/**
 * ECDSA secp256k1, offered alongside Ed25519/P-256 (SPEC.md §2.1) so an
 * ERC-8004 (EVM) identity can prove control of its key without any bridge
 * curve — secp256k1 is the curve every Ethereum wallet already uses.
 *
 * Digest = keccak256("\x19Ethereum Signed Message:\n32" + challenge), i.e.
 * Ethereum's standard `personal_sign` prefix over the 32 raw challenge bytes.
 * This means a real EVM wallet (MetaMask, viem, ethers `signMessage`) can
 * produce a valid proof signature with zero custom code on the caller's
 * side — the whole point of adding this curve.
 *
 * `secp256k1.sign`/`.verify` return/accept the 64-byte compact r||s encoding
 * and enforce low-S by default (same as p256.ts) — no manual canonicalization
 * needed here. Unlike p256.sign/verify, though, noble's secp256k1 defaults to
 * `prehash: true` (it SHA-256-hashes whatever `message` you pass before
 * signing/verifying) — since this module already hashes the challenge itself
 * (keccak256, not SHA-256, per Ethereum's `personal_sign` convention above),
 * every call below passes `{ prehash: false }` to say "this is already a
 * digest, don't hash it again." Omitting it doesn't break same-language
 * round-trips (sign and verify would both silently double-hash, cancelling
 * out) but breaks cross-language verification against sdk-python's digest —
 * caught live via the v0.18 cross-language proof before this shipped.
 */

export interface Secp256k1Keypair {
  publicKey: Uint8Array; // uncompressed SEC1, 65 bytes (0x04 || X || Y)
  privateKey: Uint8Array; // 32 bytes
}

export function generateSecp256k1Keypair(): Secp256k1Keypair {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return { privateKey, publicKey };
}

/** Ethereum's `personal_sign` prefix, applied before hashing — see module doc. */
export function ethPersonalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const prefixed = new Uint8Array(prefix.length + message.length);
  prefixed.set(prefix, 0);
  prefixed.set(message, prefix.length);
  return keccak_256(prefixed);
}

export function secp256k1Sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return secp256k1.sign(ethPersonalSignDigest(message), privateKey, { prehash: false });
}

export function secp256k1Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return secp256k1.verify(signature, ethPersonalSignDigest(message), publicKey, { prehash: false });
  } catch {
    return false;
  }
}

/** Derives the lowercase 0x-prefixed Ethereum address for an uncompressed
 * secp256k1 public key: `"0x" + hex(keccak256(pubkey[1:]))[-40:]` — the same
 * self-certifying principle INAM's own did:key (§2) uses. Required so an
 * `erc8004_id` link (SPEC.md §2.1) can't claim an address unrelated to the
 * key it just proved possession of. */
export function ethAddressFromUncompressedPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("expected an uncompressed secp256k1 public key (65 bytes, 0x04 prefix)");
  }
  const hash = keccak_256(publicKey.slice(1));
  const addressBytes = hash.slice(-20);
  return "0x" + toHex(addressBytes);
}
