// Offline reader for the delivery-receipt vectors. Node built-ins only, no INAM server, no npm install:
//   node interop/delivery/verify.mjs
// Prints PASS/FAIL per case (verdict and failed checks must equal `expected`); exits 1 if any fails.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// RFC 8785 for this I-JSON content (strings, small integers, null): sorted keys, no whitespace.
const canonical = (v) =>
  v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function didKeyToPublicKey(did) {
  if (!did.startsWith("did:key:z")) throw new Error(`not a did:key: ${did}`);
  let n = 0n;
  for (const c of did.slice(9)) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const hex = n.toString(16).padStart(68, "0");
  if (!hex.startsWith("ed01") || hex.length !== 68) throw new Error("not an Ed25519 did:key");
  return Buffer.from(hex.slice(4), "hex");
}
// ponytail: no small-order key rejection here (node:crypto has none); the SDK's verify() has it.
function sigOk(did, message, b64) {
  if (typeof b64 !== "string") return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), didKeyToPublicKey(did)]), format: "der", type: "spki" });
  return edVerify(null, message, key, Buffer.from(b64, "base64"));
}

/** Reads one receipt against the bytes the buyer observed. */
export function read(receipt, observed) {
  const { signatures, status, dispute, visibility, ...signed } = receipt;
  const { receiptVersion, receiptId, ...idContent } = signed;
  const message = Buffer.from(canonical(signed));
  const { pathname, search } = new URL(observed.request.url);
  const requestBytes = Buffer.concat([Buffer.from(`${observed.request.method.toUpperCase()} ${pathname}${search}\n`), Buffer.from(observed.request.body)]);
  const checks = {
    receiptIdRecomputes: receiptId === `sha256:${sha256(canonical(idContent))}`,
    sellerSignature: sigOk(receipt.agentB.id, message, signatures.agentB),
    buyerSignature: sigOk(receipt.agentA.id, message, signatures.agentA),
    specHashMatchesObserved: receipt.task.specHash === `sha256:${sha256(requestBytes)}`,
    outputHashMatchesObserved: receipt.result.outputHash === `sha256:${sha256(Buffer.from(observed.response.body))}`,
  };
  const failedChecks = Object.keys(checks).filter((k) => !checks[k]);
  const verdict =
    !checks.receiptIdRecomputes || !checks.sellerSignature ? "invalid"
    : !checks.buyerSignature ? "decides-nothing"
    : !checks.specHashMatchesObserved || !checks.outputHashMatchesObserved ? "not-these-bytes"
    : "weighs-against-claim";
  return { verdict, failedChecks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const v = JSON.parse(readFileSync(new URL("vectors.json", import.meta.url), "utf8"));
  let failed = 0;
  for (const c of v.cases) {
    const got = read(c.receipt, v.observed);
    const ok = got.verdict === c.expected.verdict && JSON.stringify(got.failedChecks) === JSON.stringify(c.expected.failedChecks);
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.id}: ${got.verdict}${got.failedChecks.length ? " " + JSON.stringify(got.failedChecks) : ""}`);
  }
  process.exit(failed ? 1 : 0);
}
