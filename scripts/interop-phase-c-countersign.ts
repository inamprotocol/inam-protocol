import { readFileSync } from "node:fs";
import { keypairFromPrivateKey } from "../src/crypto/keys.js";
import { InamClient } from "../src/sdk/client.js";

/**
 * Phase C of the TS<->Python cross-language demo: reload the requester
 * identity phase A registered, find the draft receipts the Python worker
 * (phase B) submitted naming us as agent_a, countersign each — finalizing a
 * receipt that was drafted, signed, and submitted entirely from Python — and
 * print the worker's resulting reputation.
 */
const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
const HANDOFF_PATH = process.env.INAM_HANDOFF ?? ".interop-tmp/requester-identity.json";
const WORKER_HANDOFF_PATH = process.env.INAM_WORKER_HANDOFF ?? ".interop-tmp/worker-identity.json";

async function main() {
  const { privateKeyHex } = JSON.parse(readFileSync(HANDOFF_PATH, "utf-8"));
  const keypair = keypairFromPrivateKey(Buffer.from(privateKeyHex, "hex"));
  const client = new InamClient(BASE_URL, keypair);

  console.log(`[phase C / TypeScript] Reloaded requester identity ${keypair.did}`);

  const { receipts } = await client.listReceipts(keypair.did);
  const drafts = receipts.filter((r) => r.status === "draft" && r.agentA.id === keypair.did);
  console.log(`[phase C / TypeScript] Found ${drafts.length} Python-submitted draft receipt(s) to countersign`);

  for (const draft of drafts) {
    const finalized = await client.acceptWork(draft);
    console.log(`[phase C / TypeScript] Countersigned ${finalized.receiptId} -> status=${finalized.status}`);
  }

  const { did: workerDid } = JSON.parse(readFileSync(WORKER_HANDOFF_PATH, "utf-8"));
  const reputation = await client.getReputation(workerDid);
  console.log(`[phase C / TypeScript] Python worker's reputation after cross-language jobs:`);
  console.log(JSON.stringify(reputation, null, 2));
}

main().catch((err) => {
  console.error("Phase C failed:", err);
  process.exitCode = 1;
});
