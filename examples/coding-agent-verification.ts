/**
 * Coding-agent verification: catching a self-reported "tests pass" that lied.
 *
 * The problem this demonstrates (real, current, widely reported): AI coding
 * agents self-report success ("tests pass", "implementation complete") and
 * requesters increasingly accept that claim on faith. Trust in that claim is
 * dropping industry-wide even as usage rises -- the reported failure mode is
 * not obviously-broken code, it's code that *looks* right and quietly isn't.
 * A receipt's own `verification.method: "test_suite_pass"` field (SPEC.md §4)
 * is exactly this kind of self-report -- the worker's own claim, signed by
 * the worker, about the worker's own work. Nothing stops it from being wrong.
 *
 * This file shows the fix already specified in SPEC.md §12: an independent
 * Verification, from a party who is not the receipt's provider, that actually
 * re-runs the check instead of trusting the self-report. Two runs:
 *
 *   1. A coding agent ships a subtly-buggy isPalindrome() -- passes the happy
 *      path, fails on mixed case / punctuation. It self-reports success
 *      anyway (this is the part that happens today, unverified). The
 *      requester finalizes the receipt the same way it would today: on faith.
 *   2. An independent verifier -- not the requester, not the provider -- pulls
 *      the actual code out of the receipt and runs a real test suite against
 *      it, in this process (SPEC.md §12.8 -- INAM never runs this itself).
 *      The bug is caught. `result: "rejected"` is signed and submitted;
 *      reputation's `attestedReceipts` does NOT increase.
 *   3. The same coding agent ships a fix. Same flow, this time the
 *      independent test suite actually passes, `result: "verified"` is
 *      submitted, and `attestedReceipts` does increase.
 *
 * The point isn't the palindrome function -- it's that "finalized" (both
 * parties signed) and "verified" (an independent party re-checked) are two
 * different, separately-visible trust levels, and only the second one
 * survives contact with a real bug.
 *
 * Runs against a local dev server (verification submission needs an operator
 * grant, same as reference-verifier.ts -- without it this still runs the real
 * test suites and prints the verdicts, it just stops short of POSTing them):
 *
 *   npm run dev                                     # terminal 1
 *   npx tsx scripts/generate-operator-keypair.ts     # once, writes operator-key.json
 *   INAM_OPERATOR_DID=<printed did> npm run dev      # terminal 1, restart with this
 *   INAM_OPERATOR_KEY=./operator-key.json \
 *     npx tsx examples/coding-agent-verification.ts  # terminal 2
 */

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
  type Keypair,
} from "../sdk-js/src/index.js";
import { readFileSync } from "node:fs";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

// --- The two code versions a "coding agent" might ship -----------------------

const BUGGY_CODE = `function isPalindrome(s) {
  return s === s.split('').reverse().join('');
}`;

const FIXED_CODE = `function isPalindrome(s) {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleaned === cleaned.split('').reverse().join('');
}`;

// The real test suite an independent verifier runs -- broader than whatever
// happy-path check the coding agent ran on itself before self-reporting.
const TEST_CASES: Array<[string, boolean]> = [
  ["racecar", true],
  ["hello", false],
  ["A man a plan a canal Panama", true],
  ["No 'x' in Nixon", true],
  ["", true],
];

function runTestSuite(code: string): { passed: number; total: number; failures: string[] } {
  const isPalindrome = new Function(`${code}\nreturn isPalindrome;`)() as (s: string) => boolean;
  const failures: string[] = [];
  let passed = 0;
  for (const [input, expected] of TEST_CASES) {
    try {
      const actual = isPalindrome(input);
      if (actual === expected) passed++;
      else failures.push(`isPalindrome(${JSON.stringify(input)}) => ${actual}, expected ${expected}`);
    } catch (err) {
      failures.push(`isPalindrome(${JSON.stringify(input)}) threw: ${(err as Error).message}`);
    }
  }
  return { passed, total: TEST_CASES.length, failures };
}

function loadOperator(): Keypair | null {
  const p = process.env.INAM_OPERATOR_KEY;
  if (!p) return null;
  const { privateKeyHex } = JSON.parse(readFileSync(p, "utf8"));
  return keypairFromPrivateKey(fromHex(privateKeyHex));
}

// --- One full round: ship code, self-report, finalize, independently verify --

async function runRound(
  label: string,
  code: string,
  coder: InamClient,
  orchestrator: InamClient,
  verifier: InamClient,
  verifierKeys: Keypair,
  operator: Keypair | null,
) {
  console.log(`\n=== Round: ${label} ===`);

  const specHash = "sha256:spec_isPalindrome_v1";
  const job = await orchestrator.postJob({ capability: "code-generation", specHash });
  await coder.submitOffer(job.jobId, "on it");
  await orchestrator.acceptOffer(job.jobId, coder.did);

  // The coding agent's own claim -- exactly what an autonomous coding agent
  // reports today: "I ran it, tests pass." This is self-attested and signed
  // only by the coder; nothing here has been independently checked yet.
  const now = new Date().toISOString();
  const draft = await coder.submitWork(orchestrator.did, {
    jobId: job.jobId,
    task: { capability: "code-generation", specHash, createdAt: now },
    result: { outputHash: `sha256:${sha256Hex(code)}`, completedAt: now },
    verification: { method: "test_suite_pass", outcome: "success" },
  });
  console.log(`Coding agent self-reports: verification.outcome = "${draft.verification?.outcome}"`);

  // The requester countersigns on faith, same as most agent-to-agent coding
  // handoffs do today. This alone is what "finalized" means -- both parties
  // agreed it happened, not that it was independently checked.
  const finalized: ExecutionReceipt = await orchestrator.acceptWork(draft);
  console.log(`Requester finalizes receipt ${finalized.receiptId} (status: ${finalized.status})`);

  // The independent check -- verification compute happens HERE, in the
  // verifier's own process (SPEC.md §12.8), not inside INAM.
  const { passed, total, failures } = runTestSuite(code);
  const outcome = passed === total ? "verified" : "rejected";
  console.log(`Independent verifier re-runs the real test suite: ${passed}/${total} passed`);
  for (const f of failures) console.log(`  FAIL: ${f}`);

  const content = buildSignableVerificationContent({
    receiptId: finalized.receiptId,
    jobId: finalized.jobId,
    provider: finalized.agentB.id,
    verifier: verifier.did,
    method: "deterministic",
    outputHash: finalized.result.outputHash,
    result: outcome,
    score: passed / total,
  });
  const signature = toBase64(sign(new TextEncoder().encode(canonicalize(content)), verifierKeys.privateKey));

  if (!operator) {
    console.log("Signed verification (not submitted -- no INAM_OPERATOR_KEY):");
    console.log(JSON.stringify({ ...content, signature }, null, 2));
    return;
  }

  const submitted = await verifier.submitVerification({
    receiptId: finalized.receiptId,
    method: "deterministic",
    outputHash: finalized.result.outputHash,
    result: outcome,
    score: passed / total,
  });
  console.log(`Submitted independent verification: result="${submitted.result}"`);
}

async function main() {
  const coder = new InamClient(BASE_URL, generateKeypair());
  const orchestrator = new InamClient(BASE_URL, generateKeypair());
  const verifierKeys = generateKeypair();
  const verifier = new InamClient(BASE_URL, verifierKeys);

  await coder.registerAgent(["code-generation"], { name: "Coding Agent" });
  await orchestrator.registerAgent(["orchestrate"], { name: "Orchestrator" });
  await verifier.registerAgent(["verification"], { name: "Independent Test Runner" });

  const operator = loadOperator();
  if (operator) {
    const op = new InamClient(BASE_URL, operator);
    await op.setVerifierStatus(verifier.did, true);
  }

  await runRound("buggy submission (self-reported success anyway)", BUGGY_CODE, coder, orchestrator, verifier, verifierKeys, operator);
  await runRound("fixed submission", FIXED_CODE, coder, orchestrator, verifier, verifierKeys, operator);

  const rep = await coder.getReputation(coder.did);
  console.log("\n=== Coding agent's reputation after both rounds ===");
  console.log(JSON.stringify(rep, null, 2));
  console.log(
    "\nBoth receipts are finalized (both parties signed). Only one is independently\n" +
      "verified -- that's the number that actually reflects whether the code worked,\n" +
      "not just whether the coding agent claimed it did.",
  );
}

main().catch((err) => {
  console.error("Coding-agent verification demo failed:", err);
  process.exitCode = 1;
});
