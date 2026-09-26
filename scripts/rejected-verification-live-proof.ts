import { InamClient, generateKeypair, keypairFromPrivateKey, sha256Hex, fromHex } from "../sdk-js/src/index.js";

/** SPEC.md v0.32 live proof, reproducing the external evaluation that found a
 * rejected Verification invisible in the score. Real HTTP through the real
 * SDK client, against either runtime:
 *
 *   INAM_URL=http://localhost:4021 OPERATOR_PRIVATE_KEY=<hex> npx tsx scripts/rejected-verification-live-proof.ts
 *
 * The server must be configured with the matching operator DID
 * (INAM_OPERATOR_DID for Node, OPERATOR_DID for the Worker). Never point this
 * at production — it writes records. */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE_URL)) throw new Error("refusing to write to a non-local registry");
const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
if (!operatorKey) throw new Error("OPERATOR_PRIVATE_KEY is required");

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!cond) failures++;
}

const operator = new InamClient(BASE_URL, keypairFromPrivateKey(fromHex(operatorKey)));
const requester = new InamClient(BASE_URL, generateKeypair());
const provider = new InamClient(BASE_URL, generateKeypair());
const verifier = new InamClient(BASE_URL, generateKeypair());

await requester.registerAgent(["job.posting"], { name: "v0.32 proof requester" });
await provider.registerAgent(["text.word-count"], { name: "v0.32 proof provider" });
await verifier.registerAgent(["verification"], { name: "v0.32 proof verifier" });
await operator.setVerifierStatus(verifier.did, true);

// Placeholder hashes are refused at the edge.
try {
  await requester.postJob({ capability: "text.word-count", specHash: "sha256:review_notes_v1" });
  check("placeholder specHash rejected", false);
} catch (err) {
  check("placeholder specHash rejected", /VALIDATION_ERROR/.test(String((err as Error).message)), (err as Error).message.slice(0, 80));
}

const TEXT = "the quick brown fox jumps over the lazy dog";
async function job(claimedCount: string) {
  const specHash = `sha256:${sha256Hex(`Count the words in: ${TEXT}`)}`;
  const outputHash = `sha256:${sha256Hex(claimedCount)}`;
  const j = await requester.postJob({ capability: "text.word-count", specHash });
  await provider.submitOffer(j.jobId, "on it");
  await requester.acceptOffer(j.jobId, provider.did);
  const now = new Date().toISOString();
  const draft = await provider.submitWork(requester.did, {
    jobId: j.jobId,
    task: { capability: "text.word-count", specHash, createdAt: now },
    result: { outputHash, completedAt: now },
    verification: { method: "independent_validator", outcome: "success" },
  });
  const receipt = await requester.acceptWork(draft, { jobId: j.jobId, outputHash });
  // The verifier recomputes the answer itself (SPEC.md §12.8) and signs its judgment.
  const correct = String(TEXT.split(" ").length) === claimedCount;
  await verifier.submitVerification({ receiptId: receipt.receiptId, method: "deterministic", outputHash, result: correct ? "verified" : "rejected" });
  return provider.getReputation(provider.did);
}

const afterGood = await job("9");
check("correct count verified -> independently_verified", afterGood.evidenceLevel === "independently_verified", afterGood.evidenceLevel);
check("successRate 1 after verified job", afterGood.components.successRate === 1, afterGood.components.successRate);

const afterBad = await job("12"); // wrong on purpose
console.log(`trustScore ${afterGood.trustScore} -> ${afterBad.trustScore}, successRate ${afterGood.components.successRate} -> ${afterBad.components.successRate}`);
check("rejected job counted", afterBad.components.rejectedAttestations === 1, afterBad.components.rejectedAttestations);
check("successRate dropped below 100%", afterBad.components.successRate < 1, afterBad.components.successRate);
check("trustScore did not rise on the rejected job", afterBad.trustScore <= afterGood.trustScore);
check("attestation_rejected flag set", afterBad.flags.includes("attestation_rejected"), afterBad.flags);
check("finalizedReceipts === verifiedReceipts alias", afterBad.components.finalizedReceipts === afterBad.components.verifiedReceipts);

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
