// Regenerates vectors.json: delivery-receipt evidence vectors (SPEC §15 receipts over HTTP) for a
// dispute-resolution reader, e.g. the "delivery receipt" policy rule proposed for ACP SEP #303.
//   npx tsx interop/delivery/generate.ts
// Byte-identical on every run (fixed test keys, deterministic Ed25519, fixed timestamps);
// tests/deliveryInterop.test.ts checks that.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { buildSignableContent, canonicalize, keypairFromPrivateKey, sign, toBase64 } from "../../sdk-js/src/index.js";
import { httpOutputHash, httpSpecHash } from "../../sdk-js/src/http.js";

const dir = fileURLToPath(new URL(".", import.meta.url));

// TEST KEYS ONLY. Derived from public strings, so anyone can sign as these DIDs.
const testKey = (label: string) => keypairFromPrivateKey(sha256(new TextEncoder().encode(`INAM interop TEST KEY, never use for real: ${label}`)));
const seller = testKey("delivery seller");
const buyer = testKey("delivery buyer");

const enc = (s: string) => new TextEncoder().encode(s);
// What the buyer's agent sent and what it received.
const REQUEST = { method: "POST", url: "https://api.seller.example/v1/report?id=42", body: '{"ticker":"ACME","period":"2026-Q3"}' };
const RESPONSE = { status: 200, body: '{"ticker":"ACME","revenue":"1204.50","currency":"USD"}' };
// The bytes a seller that signed something other than what it served would have hashed.
const OTHER_BODY = '{"ticker":"ACME","revenue":"0.00","currency":"USD"}';

function receipt(outputBody: string, buyerSigns: boolean) {
  const content = buildSignableContent(buyer.did, seller.did, {
    jobId: "http:delivery-vectors-v0.1",
    task: { capability: "data.report", specHash: httpSpecHash(REQUEST.method, REQUEST.url, enc(REQUEST.body)), createdAt: "2026-11-02T10:00:00.000Z" },
    result: { outputHash: httpOutputHash(enc(outputBody)), completedAt: "2026-11-02T10:00:01.000Z" },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  const bytes = enc(canonicalize({ ...content, dispute: undefined }));
  const agentB = toBase64(sign(bytes, seller.privateKey));
  return buyerSigns
    ? { ...content, dispute: { status: "none", windowClosesAt: "2026-11-05T10:00:01.000Z" }, signatures: { agentB, agentA: toBase64(sign(bytes, buyer.privateKey)) }, status: "finalized", visibility: "public" }
    : { ...content, dispute: { status: "none", windowClosesAt: null }, signatures: { agentB }, status: "draft", visibility: "public" };
}

export function generate() {
  const vectors = {
    suite: "inam-delivery-receipt-v0.1",
    canonicalization: "RFC 8785 (JCS) over the receipt content without signatures, status, dispute, visibility (SPEC §4.2)",
    note: "Test keys only. A reader checks receiptId, the seller (agentB) and buyer (agentA) Ed25519 signatures from their did:key, and specHash/outputHash against the bytes the buyer observed. A verdict says which bytes arrived and that the buyer accepted them, never whether they met the agreed criteria.",
    parties: { seller: seller.did, buyer: buyer.did },
    observed: {
      request: REQUEST,
      response: RESPONSE,
      derivation: "specHash = sha256(METHOD + ' ' + path?query + '\\n' + request body bytes); outputHash = sha256(response body bytes) (SPEC §15)",
    },
    verdicts: {
      "weighs-against-claim": "countersigned by the buyer, both signatures valid, hashes match what the buyer observed: weighs against a non-delivery or wrong-content claim",
      "decides-nothing": "seller-only draft: the seller's own statement, no buyer countersignature; decides nothing on its own",
      "not-these-bytes": "signatures valid but a hash does not match what the buyer observed: not evidence that these bytes arrived",
    },
    cases: [
      { id: "VALID-COUNTERSIGNED", description: "Seller signed the hashes of the bytes it served; the buyer recomputed both from what it observed and countersigned.", receipt: receipt(RESPONSE.body, true), expected: { verdict: "weighs-against-claim", failedChecks: [] } },
      { id: "HASH-MISMATCH", description: "Both signatures valid, but outputHash commits to bytes the buyer never received. A buyer that recomputes (SPEC §15 step 3) refuses to countersign this; one that signed anyway produced it.", receipt: receipt(OTHER_BODY, true), expected: { verdict: "not-these-bytes", failedChecks: ["outputHashMatchesObserved"] } },
      { id: "SELLER-ONLY-DRAFT", description: "The seller's draft over the right bytes, never countersigned by the buyer.", receipt: receipt(RESPONSE.body, false), expected: { verdict: "decides-nothing", failedChecks: ["buyerSignature"] } },
    ],
  };
  return { "vectors.json": JSON.stringify(vectors, null, 2) + "\n" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [name, text] of Object.entries(generate())) writeFileSync(dir + name, text);
  console.log("wrote vectors.json");
}
