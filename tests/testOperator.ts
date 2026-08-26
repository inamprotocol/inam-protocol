import { keypairFromPrivateKey } from "../sdk-js/src/crypto/keys.js";

/**
 * A fixed, well-known test fixture keypair standing in for "the registry
 * operator" (config.ts's `operatorDid` / INAM_OPERATOR_DID) — the one
 * identity allowed to authorize an agent as a verifier (SPEC.md §12.3).
 * Deliberately NOT random: tests need the actual private key to sign
 * verifier-authorization requests, and a fixed fixture (rather than
 * `generateKeypair()`) keeps that reproducible across runs. This keypair is
 * test-only — it has no relationship to any real deployment's actual
 * operator identity, which each registry operator configures for itself.
 */
export const testOperatorKeypair = keypairFromPrivateKey(new Uint8Array(32).fill(1));
