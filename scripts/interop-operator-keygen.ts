import { writeFileSync } from "node:fs";
import { generateKeypair } from "../sdk-js/src/crypto/keys.js";

// Throwaway registry-operator identity for the interop demo: the server is
// started with INAM_OPERATOR_DID=<this did> and phase D signs with this key.
const k = generateKeypair();
writeFileSync(
  process.env.INAM_OPERATOR_HANDOFF ?? ".interop-tmp/operator-identity.json",
  JSON.stringify({ did: k.did, privateKeyHex: Buffer.from(k.privateKey).toString("hex") }),
);
