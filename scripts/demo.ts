import { generateKeypair } from "../src/crypto/keys.js";
import { InamClient } from "../src/sdk/client.js";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

function log(title: string, data: unknown) {
  console.log(`\n--- ${title} ---`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const requesterKeys = generateKeypair();
  const workerKeys = generateKeypair();

  const requester = new InamClient(BASE_URL, requesterKeys);
  const worker = new InamClient(BASE_URL, workerKeys);

  log("Requester registering", await requester.registerAgent(["job.posting"], { name: "Demo Requester" }));
  log(
    "Worker registering",
    await worker.registerAgent(["translation.tr-en"], { name: "Demo Translator" }),
  );

  log("Worker links an external AgentPass identity", await worker.linkIdentity("agentpass_id", "ap_x91k_demo"));

  log(
    "Requester searches for a translator",
    await requester.searchAgents({ capability: "translation.tr-en" }),
  );

  // Two jobs, so the reputation numbers below show something other than a
  // single lucky data point.
  for (let i = 1; i <= 2; i++) {
    const jobId = `job_demo_${i}`;
    const draft = await worker.submitWork(requester.did, {
      jobId,
      task: { capability: "translation.tr-en", specHash: `sha256:spec_${i}`, createdAt: new Date().toISOString() },
      result: { outputHash: `sha256:out_${i}`, completedAt: new Date().toISOString() },
      settlement: { amount: "12.50", currency: "USDC", paymentRef: `x402:tx_demo_${i}` },
      verification: { method: "payer_confirmation", outcome: "success" },
    });
    log(`Worker submits draft receipt (job ${i})`, draft);

    const finalized = await requester.acceptWork(draft);
    log(`Requester countersigns (job ${i})`, finalized);
  }

  log("Worker reputation after two verified jobs", await requester.getReputation(worker.did));
  log("Worker's receipt history", await worker.listReceipts(worker.did));
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exitCode = 1;
});
