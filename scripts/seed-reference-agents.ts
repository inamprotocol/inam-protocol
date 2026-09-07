/**
 * One-time production seed: a small set of reference agents plus one real
 * finalized receipt, so `explorer.inamprotocol.org` shows a live trust graph
 * instead of an empty table (or pre-launch smoke-test junk).
 *
 * Not a demo of the protocol (that's `scripts/demo.ts` /
 * `examples/starter-agents.ts`) and not test data — these are the canonical
 * "this is what a registered agent looks like" records. Keys are written to
 * the path in SEED_KEYS_OUT so they can be reused (e.g. to post more jobs or,
 * once an operator grant exists, to attest).
 *
 *   INAM_URL=https://api.inamprotocol.org SEED_KEYS_OUT=./seed-keys.json \
 *     npx tsx scripts/seed-reference-agents.ts
 */
import { writeFileSync } from "node:fs";
import { generateKeypair, sign, toBase64, fromHex } from "../sdk-js/src/crypto/keys.js";
import { InamClient } from "../sdk-js/src/client.js";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
const KEYS_OUT = process.env.SEED_KEYS_OUT ?? "./seed-keys.json";

function log(title: string, data: unknown) {
  console.log(`\n--- ${title} ---`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const extractorKeys = generateKeypair();
  const reviewerKeys = generateKeypair();
  const translatorKeys = generateKeypair();

  const extractor = new InamClient(BASE_URL, extractorKeys);
  const reviewer = new InamClient(BASE_URL, reviewerKeys);
  const translator = new InamClient(BASE_URL, translatorKeys);

  log("Reference: document-extraction agent", await extractor.registerAgent(["document-extraction"], {
    name: "Reference Extractor",
    description: "Reference INAM agent — batch document field extraction. Seeded by the protocol maintainer.",
    url: "https://inamprotocol.org",
  }));
  log("Reference: code-review agent", await reviewer.registerAgent(["code-review"], {
    name: "Reference Reviewer",
    description: "Reference INAM agent — automated code review against a spec. Seeded by the protocol maintainer.",
    url: "https://inamprotocol.org",
  }));
  log("Reference: translation agent", await translator.registerAgent(["translation.tr-en"], {
    name: "Reference Translator",
    description: "Reference INAM agent — Turkish→English translation. Seeded by the protocol maintainer.",
    url: "https://inamprotocol.org",
  }));

  // One real end-to-end engagement so reputation numbers are non-zero and the
  // explorer's receipt view has something in it.
  const specHash = "sha256:reference_review_spec_v1";
  const job = await extractor.postJob({ capability: "code-review", specHash });
  log("Extractor posts a code-review job", job);

  await reviewer.submitOffer(job.jobId, "Reference offer");
  await extractor.acceptOffer(job.jobId, reviewer.did);

  const now = new Date().toISOString();
  const draft = await reviewer.submitWork(extractor.did, {
    jobId: job.jobId,
    task: { capability: "code-review", specHash, createdAt: now },
    result: { outputHash: "sha256:reference_review_notes_v1", completedAt: now },
    settlement: { amount: "40.00", currency: "USDC", paymentRef: "x402:reference_1" },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  const finalized = await extractor.acceptWork(draft);
  log("Receipt finalized", finalized);

  const [extractorRep, reviewerRep] = await Promise.all([
    extractor.getReputation(extractor.did),
    reviewer.getReputation(reviewer.did),
  ]);
  log("Reputations", { extractor: extractorRep, reviewer: reviewerRep });

  writeFileSync(KEYS_OUT, JSON.stringify({
    extractor: { did: extractor.did, privateKeyHex: Buffer.from(extractorKeys.privateKey).toString("hex") },
    reviewer: { did: reviewer.did, privateKeyHex: Buffer.from(reviewerKeys.privateKey).toString("hex") },
    translator: { did: translator.did, privateKeyHex: Buffer.from(translatorKeys.privateKey).toString("hex") },
  }, null, 2));
  console.log(`\nKeys written to ${KEYS_OUT}`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exitCode = 1;
});
