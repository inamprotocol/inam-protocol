// Offline check of the EMILIA Gate action -> INAM receipt binding. Node built-ins only,
// no INAM server, no npm install:   node interop/emilia/verify.mjs
// Prints PASS/FAIL per case; exits 1 if any case fails.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
// Git blob of conformance/composition/consequence-admission-lifecycle-v0.1/vectors.json
// at emiliaprotocol/emilia-protocol@3f712d28b2cf624342bd98c4172e1a574b39644b.
const UPSTREAM_SHA256 = "be2b85188ea3b7b855dc92d9c8a813fffff8a4da5efd0d9ef56d16f7b9409380";
// caid-verify-valid.vector.json is the "verify-valid" entry of caid/conformance/vectors.json
// (CAID-CORE-VECTORS version 6, file sha256 f87ab5f3827a3b3072c84918ad2d299e5d637096affe4b68e2524efb074655cb)
// at the same commit, extracted unchanged. Pin: sha256 of that entry's canonical bytes.
const CAID_VECTOR_SHA256 = "07496c28bf958df2ba822b5cc37ce979d0f305b2641de8f48ada42088eae038b";
const CAID_DEFINITION_SHA256 = "sha256:3a5ad4c0a3a8dbf7eb9ea5f4c3b2ceb07ba1972fac49acc6006dcac64726ff12";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// Sorted keys, no whitespace: INAM canonical() (SPEC §4.2) and EMILIA run.mjs canonicalize();
// for this all-string action it is also RFC 8785 output.
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
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), didKeyToPublicKey(did)]), format: "der", type: "spki" });
  return edVerify(null, message, key, Buffer.from(b64, "base64"));
}

/** Checks one (receipt, action) pair. accepted === every check true. */
export function verifyBinding(receipt, action) {
  const { signatures, status, dispute, visibility, ...signed } = receipt;
  const { receiptVersion, receiptId, ...idContent } = signed;
  const message = Buffer.from(canonical(signed));
  const checks = {
    specHashBindsAction: receipt.task.specHash === `sha256:${sha256(canonical(action))}`,
    receiptIdRecomputes: receiptId === `sha256:${sha256(canonical(idContent))}`,
    workerSignature: sigOk(receipt.agentB.id, message, signatures.agentB),
    requesterSignature: sigOk(receipt.agentA.id, message, signatures.agentA),
  };
  return { accepted: Object.values(checks).every(Boolean), checks };
}

export function runCases() {
  const raw = readFileSync(dir + "consequence-admission-lifecycle-v0.1.vectors.json");
  const corpus = JSON.parse(raw);
  const receipt = JSON.parse(readFileSync(dir + "receipt.json", "utf8"));
  const negative = JSON.parse(readFileSync(dir + "negative-action.json", "utf8"));
  const admitted = corpus.cases.find((c) => c.id === "AUTHZEN-EXACT-ACTION-ADMITTED-ONCE");
  const diffBytes = [...Buffer.from(canonical(corpus.base_action))].filter((b, i) => b !== Buffer.from(canonical(negative))[i]).length;
  return [
    { name: "EMILIA fixture is the unchanged upstream file", expected: true, actual: sha256(raw) === UPSTREAM_SHA256 },
    { name: "base_action is the one Gate admits in AUTHZEN-EXACT-ACTION-ADMITTED-ONCE", expected: true, actual: admitted?.scenario === "ADMIT_THEN_REPLAY" && admitted?.expected === "EXECUTED_THEN_REFUSED" },
    { name: "positive: receipt binds the admitted action, both signatures valid", expected: true, actual: verifyBinding(receipt, corpus.base_action).accepted, detail: verifyBinding(receipt, corpus.base_action).checks },
    { name: "negative fixture differs from the admitted action by exactly one byte", expected: true, actual: diffBytes === 1 && canonical(negative).length === canonical(corpus.base_action).length },
    { name: "negative: same receipt against the one-byte-changed action is rejected", expected: false, actual: verifyBinding(receipt, negative).accepted, detail: verifyBinding(receipt, negative).checks },
    ...caidCases(),
  ];
}

/** Typed case: a CAID-valid action. specHash and the CAID digest are the same 32 octets. */
function caidCases() {
  const vector = JSON.parse(readFileSync(dir + "caid-verify-valid.vector.json", "utf8"));
  const receipt = JSON.parse(readFileSync(dir + "receipt-caid.json", "utf8"));
  const negative = JSON.parse(readFileSync(dir + "negative-caid-action.json", "utf8"));
  const action = JSON.parse(vector.input.json);
  // canactid:1:<action_type>:jcs-sha256:<base64url digest>. JCS = canonical() here: every value is a string.
  const [scheme, ver, actionType, suite, digest] = vector.input.caid.split(":");
  const specDigest = Buffer.from(receipt.task.specHash.slice(7), "hex");
  return [
    { name: "CAID vector is EMILIA's verify-valid, unchanged, with its definition pin", expected: true,
      actual: sha256(canonical(vector)) === CAID_VECTOR_SHA256 && vector.id === "verify-valid" && vector.expect.valid === true && vector.expect.definition_sha256 === CAID_DEFINITION_SHA256 },
    { name: "CAID digest recomputes from the action, and equals the receipt's specHash", expected: true,
      actual: scheme === "canactid" && ver === "1" && suite === "jcs-sha256" && actionType === action.action_type
        && createHash("sha256").update(canonical(action)).digest("base64url") === digest && specDigest.toString("base64url") === digest
        && receipt.task.capability === actionType },
    { name: "positive (typed): receipt binds the CAID-valid action, both signatures valid", expected: true, actual: verifyBinding(receipt, action).accepted, detail: verifyBinding(receipt, action).checks },
    { name: "negative (typed): same receipt against the changed-amount action is rejected", expected: false, actual: verifyBinding(receipt, negative).accepted, detail: verifyBinding(receipt, negative).checks },
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let failed = 0;
  for (const c of runCases()) {
    const ok = c.actual === c.expected;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  " + JSON.stringify(c.detail) : ""}`);
  }
  process.exit(failed ? 1 : 0);
}
