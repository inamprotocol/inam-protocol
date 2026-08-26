import { keypairFromPrivateKey } from "../../sdk-js/src/crypto/keys.js";

/**
 * A fixed, well-known test fixture keypair standing in for "the registry
 * operator" (env.OPERATOR_DID) — the one identity allowed to authorize an
 * agent as a verifier (SPEC.md §12.3). Its DID is injected as a test-only
 * OPERATOR_DID binding in ../vitest.config.ts (kept in sync with this file's
 * private key by hand -- both must derive to the same DID). Deliberately
 * NOT random: tests need the actual private key to sign
 * verifier-authorization requests. This keypair is test-only -- it has no
 * relationship to any real deployment's actual operator identity, which
 * each registry operator configures for itself (see
 * docs-design or the migration/setup notes for env.OPERATOR_DID).
 */
export const testOperatorKeypair = keypairFromPrivateKey(new Uint8Array(32).fill(2));
