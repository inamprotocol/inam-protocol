// Regenerates receipt.json, negative-action.json, receipt-caid.json and negative-caid-action.json
// from the copied EMILIA fixtures.
//   npx tsx interop/emilia/generate.ts
// Output is byte-identical on every run (fixed test keys, Ed25519 is deterministic);
// tests/emiliaInterop.test.ts checks that.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSignableContent, canonicalize, keypairFromPrivateKey, sha256Hex, sign, toBase64, type ReceiptContentInput } from "../../sdk-js/src/index.js";
import { sha256 } from "@noble/hashes/sha256";

const dir = fileURLToPath(new URL(".", import.meta.url));
export const VECTORS_FILE = "consequence-admission-lifecycle-v0.1.vectors.json";
export const ADMITTED_CASE = "AUTHZEN-EXACT-ACTION-ADMITTED-ONCE";

// TEST KEYS ONLY. Derived from public strings, so anyone can sign as these DIDs.
export const testKey = (label: string) =>
  keypairFromPrivateKey(sha256(new TextEncoder().encode(`INAM interop TEST KEY, never use for real: ${label}`)));

export const CAID_VECTOR_FILE = "caid-verify-valid.vector.json";

/** A finalized receipt whose task.specHash binds `action`'s canonical bytes. */
function receiptFor(action: { action_type: string; amount: string; currency: string }, jobId: string, createdAt: string, completedAt: string, windowClosesAt: string) {
  const worker = testKey("emilia worker");
  const requester = testKey("emilia requester");
  const input: ReceiptContentInput = {
    jobId,
    // Same bytes and digest as EMILIA's exact_action_digest (run.mjs digest()) and, for a
    // CAID-valid typed action, the same 32 octets as the CAID digest (base64url there, hex here).
    task: { capability: action.action_type, specHash: `sha256:${sha256Hex(canonicalize(action))}`, createdAt },
    // Synthetic provider result; not an EMILIA artifact. The binding under test is specHash.
    result: { outputHash: `sha256:${sha256Hex("EXECUTED")}`, completedAt },
    settlement: { amount: action.amount, currency: action.currency },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
  const content = buildSignableContent(requester.did, worker.did, input);
  const bytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  return {
    ...content,
    dispute: { status: "none", windowClosesAt },
    signatures: { agentB: toBase64(sign(bytes, worker.privateKey)), agentA: toBase64(sign(bytes, requester.privateKey)) },
    status: "finalized",
    visibility: "public",
  };
}

export function generate() {
  const corpus = JSON.parse(readFileSync(dir + VECTORS_FILE, "utf8"));
  const action = corpus.base_action;
  const receipt = receiptFor(action, `emilia:consequence-admission-lifecycle-v0.1:${ADMITTED_CASE}`, "2026-09-24T18:00:00Z", "2026-09-24T18:00:01Z", "2026-09-27T18:00:01Z");
  // One byte of the canonical action changes: "50.00" -> "50.01".
  const negative = { ...action, amount: "50.01" };

  // Typed case: the CAID-valid payment.release.1 object from EMILIA's CAID vectors (verify-valid).
  const caidAction = JSON.parse(JSON.parse(readFileSync(dir + CAID_VECTOR_FILE, "utf8")).input.json);
  const caidReceipt = receiptFor(caidAction, "emilia:caid-core-vectors-6:verify-valid", "2026-11-02T12:00:00Z", "2026-11-02T12:00:01Z", "2026-11-05T12:00:01Z");
  const caidNegative = { ...caidAction, amount: "250.01" };
  return {
    "receipt.json": JSON.stringify(receipt, null, 2) + "\n",
    "negative-action.json": JSON.stringify(negative, null, 2) + "\n",
    "receipt-caid.json": JSON.stringify(caidReceipt, null, 2) + "\n",
    "negative-caid-action.json": JSON.stringify(caidNegative, null, 2) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, text] of Object.entries(generate())) writeFileSync(dir + name, text);
  console.log(`wrote ${Object.keys(generate()).join(", ")}`);
}
