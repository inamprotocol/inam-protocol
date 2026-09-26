import { readFileSync } from "node:fs";
import { InamClient, keypairFromPrivateKey, fromHex } from "../sdk-js/src/index.js";

/** Operator-only: grant (or with --revoke, revoke) verifier status (SPEC.md §12.6).
 *
 *   npx tsx scripts/grant-verifier.ts <verifier did:key> [--revoke]
 *
 * Signs with the operator key in operator-key.json (gitignored; written by
 * scripts/generate-operator-keypair.ts). Its DID must match the registry's
 * OPERATOR_DID, or the call fails with NOT_OPERATOR. The target must already
 * be registered (integrity-verifier.ts self-registers on its first run). */
const BASE_URL = process.env.INAM_URL ?? "https://api.inamprotocol.org";
const [target, flag] = process.argv.slice(2);
if (!target?.startsWith("did:key:")) throw new Error("usage: grant-verifier.ts <did:key:...> [--revoke]");

const { privateKeyHex } = JSON.parse(readFileSync(process.env.INAM_OPERATOR_KEY ?? "operator-key.json", "utf8"));
const operator = new InamClient(BASE_URL, keypairFromPrivateKey(fromHex(privateKeyHex)));
const record = await operator.setVerifierStatus(target, flag !== "--revoke");
console.log(`${record.id}: isAuthorizedVerifier = ${record.isAuthorizedVerifier} on ${BASE_URL}`);
