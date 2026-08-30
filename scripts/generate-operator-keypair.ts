/**
 * One-off: generate the INAM Protocol registry OPERATOR keypair
 * (SPEC.md §12.3 — the single identity allowed to grant/revoke an agent's
 * verifier status).
 *
 * Run from the repo root:
 *   npx tsx scripts/generate-operator-keypair.ts
 *
 * - The `did:key:...` printed to the screen is PUBLIC. It is the value for
 *   the Worker's `OPERATOR_DID` secret and the Node server's
 *   `INAM_OPERATOR_DID` env var.
 * - `operator-key.json` holds the PRIVATE key. Move its contents into a
 *   password manager / secrets vault and delete the file. Whoever holds
 *   this private key can authorize any agent as a verifier.
 */
import { writeFileSync, existsSync } from "node:fs";
import { generateKeypair, toHex, toBase64 } from "../sdk-js/src/crypto/keys.js";

const OUT = "operator-key.json";
if (existsSync(OUT)) {
  console.error(`Refusing to overwrite existing ${OUT} — move or delete it first.`);
  process.exit(1);
}

const kp = generateKeypair();

writeFileSync(
  OUT,
  JSON.stringify(
    {
      did: kp.did,
      privateKeyHex: toHex(kp.privateKey),
      privateKeyBase64: toBase64(kp.privateKey),
      publicKeyHex: toHex(kp.publicKey),
      createdAt: new Date().toISOString(),
      note: "INAM Protocol registry operator key. `did` is public; `privateKey*` is secret.",
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

console.log("\n  OPERATOR DID (public — use as OPERATOR_DID / INAM_OPERATOR_DID):\n");
console.log("    " + kp.did + "\n");
console.log(`  Private key written to ./${OUT}`);
console.log("  -> Move it into your password manager / secret store, then delete the file.\n");
