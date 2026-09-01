/**
 * Reference verifier: where verification compute actually runs (SPEC.md §12.8).
 *
 * The "no agent runtime" boundary (SPEC.md §0) applies to verification too.
 * INAM defines the *attestation* — its format (§12.1), its ID (§12.2), the
 * trust rules a registry enforces on submission (§12.3). It does NOT define
 * or operate an environment to run the underlying check in. That check runs
 * here, in the verifier's own process, at the verifier's own cost. The
 * registry's entire job on `POST /verifications` is: validate the signature,
 * check the operator's verifier grant, check the output hash matches the
 * receipt. It never fetches the output, never re-runs a test, never looks at
 * the work.
 *
 * This file is "shape 1" from §12.8 — inline: the check runs in the same
 * process that holds the verifier's key. "Shape 2" (a separate service the
 * verifier deploys itself — its own edge worker, CI job, TEE) is the same
 * code living somewhere else; the registry can't tell the difference and
 * doesn't try to.
 *
 * Runnable against a local dev server:
 *
 *   npm run dev                              # terminal 1
 *   npx tsx examples/reference-verifier.ts    # terminal 2
 *
 * To also SUBMIT the signed verification (not just build it), the dev server
 * needs an operator identity and this script needs that operator's key:
 *
 *   npx tsx scripts/generate-operator-keypair.ts          # writes operator-key.json
 *   INAM_OPERATOR_DID=<the printed did> npm run dev        # terminal 1
 *   INAM_OPERATOR_KEY=./operator-key.json \
 *     npx tsx examples/reference-verifier.ts                # terminal 2
 *
 * Without INAM_OPERATOR_KEY it stops after signing and prints exactly what
 * the registry would (and would not) do with the payload.
 */

import { readFileSync } from "node:fs";
import {
  InamClient,
  generateKeypair,
  keypairFromPrivateKey,
  fromHex,
  sha256Hex,
  canonicalize,
  buildSignableVerificationContent,
  sign,
  toBase64,
  type ExecutionReceipt,
} from "../sdk-js/src/index.js";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

// The actual work output the verifier is checking. In a real verifier this is
// fetched from receipt.result.outputUri (or re-derived by re-running the job's
// deterministic step); here it's inline so the example needs no external fetch.
const WORK_OUTPUT = "the mitochondria is the powerhouse of the cell";

async function seedFinalizedReceipt(): Promise<ExecutionReceipt> {
  // Not the point of this example — just produces one real finalized receipt
  // for the verifier to check. (starter-agents.ts covers this flow in full.)
  const worker = new InamClient(BASE_URL, generateKeypair());
  const requester = new InamClient(BASE_URL, generateKeypair());
  await worker.registerAgent(["summarize"], { name: "Worker" });
  await requester.registerAgent(["orchestrate"], { name: "Requester" });

  const specHash = "sha256:summarize_spec_v1";
  const job = await requester.postJob({ capability: "summarize", specHash });
  await worker.submitOffer(job.jobId, "on it");
  await requester.acceptOffer(job.jobId, worker.did);

  const now = new Date().toISOString();
  const draft = await worker.submitWork(requester.did, {
    jobId: job.jobId,
    task: { capability: "summarize", specHash, createdAt: now },
    result: { outputHash: `sha256:${sha256Hex(WORK_OUTPUT)}`, completedAt: now },
    verification: { method: "test_suite_pass", outcome: "success" },
  });
  return requester.acceptWork(draft);
}

function loadOperator() {
  const p = process.env.INAM_OPERATOR_KEY;
  if (!p) return null;
  const { privateKeyHex } = JSON.parse(readFileSync(p, "utf8"));
  return keypairFromPrivateKey(fromHex(privateKeyHex));
}

async function main() {
  const verifierKeys = generateKeypair();
  const verifier = new InamClient(BASE_URL, verifierKeys);
  await verifier.registerAgent(["verification"], { name: "Reference Verifier" });

  const receipt = await seedFinalizedReceipt();
  console.log(`\nVerifying receipt ${receipt.receiptId} (status: ${receipt.status})`);

  // --- 1. Read the receipt. Unsigned GET, no auth, no cost to anyone. -------
  const target = await verifier.getReceipt(receipt.receiptId);

  // --- 2. Run the check. THIS is the verification compute. -----------------
  // It runs in this process. The registry does not do this step and has no
  // way to. A `deterministic` check (SPEC.md §12.1): hash the actual output,
  // compare to what the receipt claims. A real verifier fetches the output
  // from target.result.outputUri or re-runs the job's deterministic step;
  // an `agent_attestation` verifier would instead have an LLM examine it here.
  const recomputed = `sha256:${sha256Hex(WORK_OUTPUT)}`;
  const passed = recomputed === target.result.outputHash;
  console.log(`  recomputed output hash: ${recomputed}`);
  console.log(`  receipt claims:         ${target.result.outputHash}`);
  console.log(`  check result: ${passed ? "verified" : "rejected"}`);

  // --- 3. Sign the attestation over the verdict from step 2. ---------------
  const content = buildSignableVerificationContent({
    receiptId: target.receiptId,
    jobId: target.jobId,
    provider: target.agentB.id,
    verifier: verifier.did,
    method: "deterministic",
    outputHash: target.result.outputHash,
    result: passed ? "verified" : "rejected",
    score: passed ? 1 : 0,
  });
  const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), verifierKeys.privateKey));

  // --- 4. Submit — or show what submission would involve. -----------------
  const operator = loadOperator();
  if (!operator) {
    console.log("\nSigned verification (not submitted — no INAM_OPERATOR_KEY):");
    console.log(JSON.stringify({ ...content, signature }, null, 2));
    console.log(
      "\nOn POST /verifications the registry would ONLY: check this signature against\n" +
        "the verifier's key, check the verifier has an operator grant (§12.3 rule 4),\n" +
        "check outputHash matches the receipt. It would NOT re-run step 2's check.",
    );
    return;
  }

  const op = new InamClient(BASE_URL, operator);
  await op.setVerifierStatus(verifier.did, true); // operator grant — §12.3 rule 4
  const submitted = await verifier.submitVerification({
    receiptId: target.receiptId,
    method: "deterministic",
    outputHash: target.result.outputHash,
    result: passed ? "verified" : "rejected",
    score: passed ? 1 : 0,
  });
  console.log("\nSubmitted verification:");
  console.log(JSON.stringify(submitted, null, 2));
}

main().catch((err) => {
  console.error("Reference verifier failed:", err);
  process.exitCode = 1;
});
