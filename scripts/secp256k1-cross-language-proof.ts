/**
 * Live cross-language proof for SPEC.md v0.18's secp256k1 keyType: generates
 * a keypair + signs a challenge in TypeScript (sdk-js), writes it to a file,
 * then a companion Python script (secp256k1_cross_language_proof.py) reads
 * it, verifies it with sdk-python, signs its own challenge, and this script's
 * second half verifies that back. Same pattern as the P-256 low-S bug this
 * project was previously burned by (see p256.py's docstring) — run for real,
 * not just unit-tested against itself, since same-language sign+verify can't
 * catch an asymmetric bug (both sides silently agreeing on a wrong digest).
 */
import { writeFileSync, readFileSync } from "fs";
import { toBase64, fromBase64, toHex, fromHex } from "../sdk-js/src/crypto/keys.js";
import { generateSecp256k1Keypair, secp256k1Sign, secp256k1Verify, ethAddressFromUncompressedPublicKey } from "../sdk-js/src/crypto/secp256k1.js";

const VECTOR_PATH = new URL("./secp256k1-cross-language-vector.json", import.meta.url);

const mode = process.argv[2];

if (mode === "sign") {
  const kp = generateSecp256k1Keypair();
  const challenge = fromHex("aa".repeat(32)); // stand-in for a real 32-byte server challenge
  const sig = secp256k1Sign(challenge, kp.privateKey);
  const address = ethAddressFromUncompressedPublicKey(kp.publicKey);
  writeFileSync(
    VECTOR_PATH,
    JSON.stringify({ publicKey: toBase64(kp.publicKey), challenge: toHex(challenge), tsSignature: toBase64(sig), address }, null, 2),
  );
  console.log("TS signed. publicKey/challenge/tsSignature/address written to", VECTOR_PATH.pathname);
} else if (mode === "verify-python") {
  const data = JSON.parse(readFileSync(VECTOR_PATH, "utf8"));
  const publicKey = fromBase64(data.publicKey);
  const challenge = fromHex(data.challenge);
  const pySig = fromBase64(data.pythonSignature);
  const ok = secp256k1Verify(pySig, challenge, publicKey);
  console.log("TS verifying Python-produced signature:", ok);
  const derivedAddress = ethAddressFromUncompressedPublicKey(publicKey);
  console.log("address match:", derivedAddress === data.address, derivedAddress, data.address);
  if (!ok || derivedAddress !== data.address) process.exit(1);
} else {
  console.error("usage: tsx secp256k1-cross-language-proof.ts sign|verify-python");
  process.exit(1);
}
