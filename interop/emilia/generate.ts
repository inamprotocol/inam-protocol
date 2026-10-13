// Regenerates receipt.json and negative-action.json from the copied EMILIA fixture.
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

export function generate() {
  const corpus = JSON.parse(readFileSync(dir + VECTORS_FILE, "utf8"));
  const action = corpus.base_action;
  const worker = testKey("emilia worker");
  const requester = testKey("emilia requester");
  const input: ReceiptContentInput = {
    jobId: `emilia:consequence-admission-lifecycle-v0.1:${ADMITTED_CASE}`,
    // Same bytes and digest as EMILIA's exact_action_digest (run.mjs digest()).
    task: { capability: action.action_type, specHash: `sha256:${sha256Hex(canonicalize(action))}`, createdAt: "2026-09-24T18:00:00Z" },
    // Synthetic provider result; not an EMILIA artifact. The binding under test is specHash.
    result: { outputHash: `sha256:${sha256Hex("EXECUTED")}`, completedAt: "2026-09-24T18:00:01Z" },
    settlement: { amount: action.amount, currency: action.currency },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
  const content = buildSignableContent(requester.did, worker.did, input);
  const bytes = new TextEncoder().encode(canonicalize({ ...content, dispute: undefined }));
  const receipt = {
    ...content,
    dispute: { status: "none", windowClosesAt: "2026-09-27T18:00:01Z" },
    signatures: { agentB: toBase64(sign(bytes, worker.privateKey)), agentA: toBase64(sign(bytes, requester.privateKey)) },
    status: "finalized",
    visibility: "public",
  };
  // One byte of the canonical action changes: "50.00" -> "50.01".
  const negative = { ...action, amount: "50.01" };
  return {
    "receipt.json": JSON.stringify(receipt, null, 2) + "\n",
    "negative-action.json": JSON.stringify(negative, null, 2) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, text] of Object.entries(generate())) writeFileSync(dir + name, text);
  console.log("wrote receipt.json, negative-action.json");
}
