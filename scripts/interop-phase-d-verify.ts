import { readFileSync } from "node:fs";
import { generateKeypair } from "../sdk-js/src/crypto/keys.js";
import { InamClient } from "../sdk-js/src/client.js";

/**
 * Phase D of the TS<->Python cross-language demo: a fresh, independent
 * verifier identity (neither the requester nor the Python worker) submits a
 * signed Verification (SPEC.md §12) against one of the receipts that was
 * drafted in Python (phase B) and countersigned in TypeScript (phase C) —
 * proving the full chain end to end across both languages on one shared
 * object, not just that each language can talk to the registry on its own.
 */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
const WORKER_HANDOFF_PATH = process.env.INAM_WORKER_HANDOFF ?? ".interop-tmp/worker-identity.json";

async function main() {
  const { did: workerDid } = JSON.parse(readFileSync(WORKER_HANDOFF_PATH, "utf-8"));

  const verifier = new InamClient(BASE_URL, generateKeypair());
  await verifier.registerAgent(["verification"]);
  console.log(`[phase D / TypeScript] Registered independent verifier ${verifier.did}`);

  const { receipts } = await verifier.listReceipts(workerDid);
  const finalized = receipts.filter((r) => r.status === "finalized" && r.agentB.id === workerDid);
  console.log(`[phase D / TypeScript] Found ${finalized.length} finalized receipt(s) from the Python worker to verify`);

  for (const receipt of finalized) {
    const record = await verifier.submitVerification({
      receiptId: receipt.receiptId,
      method: "deterministic",
      outputHash: receipt.result.outputHash,
      result: "verified",
    });
    console.log(`[phase D / TypeScript] Verified ${record.receiptId} -> verificationId=${record.verificationId}`);
  }

  const reputation = await verifier.getReputation(workerDid);
  console.log(`[phase D / TypeScript] Python worker's reputation after independent verification:`);
  console.log(JSON.stringify(reputation, null, 2));
  if (reputation.components.attestedReceipts !== finalized.length) {
    throw new Error(`Expected attestedReceipts=${finalized.length}, got ${reputation.components.attestedReceipts}`);
  }
}

main().catch((err) => {
  console.error("Phase D failed:", err);
  process.exitCode = 1;
});
