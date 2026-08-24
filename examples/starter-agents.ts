/**
 * Starter agents: a small multi-party demo network.
 *
 * `scripts/demo.ts` is the minimal two-agent (requester + worker) end-to-end
 * flow. This file is the same idea widened to three agents with three
 * distinct declared capabilities, running the full chain SPEC.md describes:
 *
 *   Job posted -> offered -> accepted -> Receipt (draft -> finalized) -> Verification
 *
 * The three "starter agents" here are illustrative stand-ins for the kind of
 * agents a real INAM-registered fleet might run (a document-extraction
 * pipeline, a code-review bot, a translation service) -- not three separate
 * framework integrations. The point of Phase 5.2 isn't N different agent
 * runtimes, it's showing what it looks like for several independently-built,
 * independently-capable agents to transact and vouch for each other on the
 * same registry.
 *
 * Run against a local dev server (see CONTRIBUTING.md for the two `npm
 * install` steps -- root and sdk-js/ are separate packages):
 *
 *   npm run dev              # terminal 1
 *   npx tsx examples/starter-agents.ts   # terminal 2
 */

import { InamClient, generateKeypair, type Keypair } from "../sdk-js/src/index.js";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";

function log(title: string, data: unknown) {
  console.log(`\n--- ${title} ---`);
  console.log(JSON.stringify(data, null, 2));
}

function agent(baseUrl: string, keypair: Keypair) {
  return new InamClient(baseUrl, keypair);
}

async function main() {
  // Three agents, three distinct declared capabilities (AgentRecord.capabilities,
  // SPEC.md §2) -- this is how the registry's search index knows who can even
  // be considered for a given job, before anyone talks to anyone.
  const extractorKeys = generateKeypair();
  const reviewerKeys = generateKeypair();
  const translatorKeys = generateKeypair();

  const extractor = agent(BASE_URL, extractorKeys); // capability: document-extraction
  const reviewer = agent(BASE_URL, reviewerKeys); // capability: code-review
  const translator = agent(BASE_URL, translatorKeys); // capability: translation.tr-en

  log("Extractor registers", await extractor.registerAgent(["document-extraction"], { name: "Doc Extractor" }));
  log("Reviewer registers", await reviewer.registerAgent(["code-review"], { name: "Code Reviewer" }));
  log("Translator registers", await translator.registerAgent(["translation.tr-en"], { name: "TR->EN Translator" }));

  // --- Step 1: post a job (SPEC.md §3) -----------------------------------
  // Why a job exists as its own resource instead of the extractor just
  // handing the reviewer a receipt to sign: at this point the extractor
  // doesn't necessarily know *who* will do the review yet. A job is an open
  // advertisement ("I need `code-review` done against this spec") that any
  // registered agent with that capability can discover via search and offer
  // on -- it's the discovery/negotiation step that has to happen *before*
  // there are two parties to put in a receipt. Submitting a receipt directly
  // only makes sense once both sides already know and agree who's doing the
  // work; postJob is what gets you there in an open marketplace.
  const specHash = "sha256:review_spec_extraction_pipeline_v1";
  const job = await extractor.postJob({ capability: "code-review", specHash });
  log("Extractor posts a job needing code review", job);

  // --- Step 2: discover and offer (SPEC.md §3) ----------------------------
  // The reviewer doesn't need to be told about this job out of band -- it
  // finds it the same way any agent finds work: searching the registry by
  // capability.
  const found = await reviewer.searchJobs({ capability: "code-review", status: "open" });
  log("Reviewer searches for open code-review jobs", found);

  const offered = await reviewer.submitOffer(job.jobId, "I can review this by end of day");
  log("Reviewer offers", offered);

  // Only the job's poster may accept an offer (enforced server-side as
  // NOT_POSTER otherwise) -- this is what turns an open job into a committed
  // two-party engagement. Once accepted, the registry will reject a receipt
  // for this job from anyone other than these two exact parties
  // (JOB_PARTY_MISMATCH), so there's no way for a third agent to swoop in
  // and claim credit for work it didn't get accepted for.
  const accepted = await extractor.acceptOffer(job.jobId, reviewer.did);
  log("Extractor accepts the reviewer's offer", accepted);

  // --- Step 3: do the work, submit a draft receipt (SPEC.md §4) ----------
  // The receipt's jobId ties back to the job above -- the registry checks
  // that agentB (the reviewer, submitting here) matches the job's accepted
  // offer and agentA (the extractor) matches the job's poster. This is what
  // makes the job step more than decorative: it's the source of truth the
  // receipt gets validated against, not just a courtesy record.
  const now = new Date().toISOString();
  const draft = await reviewer.submitWork(extractor.did, {
    jobId: job.jobId,
    task: { capability: "code-review", specHash, createdAt: now },
    result: { outputHash: "sha256:review_notes_v1", completedAt: now },
    settlement: { amount: "40.00", currency: "USDC", paymentRef: "x402:tx_starter_1" },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  log("Reviewer submits a draft receipt", draft);

  // --- Step 4: countersign to finalize (SPEC.md §4.2) ---------------------
  // A receipt only counts toward reputation once *both* parties have signed
  // it -- the worker's draft signature alone only proves the worker claims
  // the work happened; the requester's countersignature is what proves the
  // requester agrees it happened as described. Two independent signatures
  // over the same content, not a single party's unilateral claim.
  const finalized = await extractor.acceptWork(draft);
  log("Extractor countersigns -- receipt is now finalized", finalized);

  // --- Step 5: an independent third party attests to the work (SPEC.md §12) ---
  // The translator has nothing to do with document extraction or code
  // review -- and that's the point. A Verification's `verifier` only has to
  // not be the receipt's own provider (SELF_VERIFICATION guards against
  // rubber-stamping your own work); the protocol doesn't require the
  // verifier's declared capability to match the job's. Any other registered
  // agent can act as an independent auditor. `method: "agent_attestation"`
  // here means "another agent examined the work and attests to it" -- note
  // this is a *different* enum than the receipt's own `verification.method`
  // field (which is `payer_confirmation` / `independent_validator` /
  // `test_suite_pass`); §12's Verification methods are `deterministic` or
  // `agent_attestation` only.
  const verification = await translator.submitVerification({
    receiptId: finalized.receiptId,
    method: "agent_attestation",
    outputHash: finalized.result.outputHash,
    result: "verified",
    score: 0.95,
  });
  log("Translator independently verifies the finalized receipt", verification);

  // --- Step 6: reputations side by side ------------------------------------
  // Reputation counts a receipt for *both* named parties, not just the
  // worker (see `src/services/reputationService.ts` -- a receipt's
  // counterparty lookup works in either direction), so extractor and
  // reviewer both show one finalized, independently-attested receipt
  // (attestedReceipts: 1, per SPEC.md §12.5's boost) even though only the
  // reviewer did the billable work. The translator only ever *submitted a
  // Verification* -- it was never a receipt party -- so it still shows the
  // registry's baseline for an agent with zero receipts of its own.
  const [extractorRep, reviewerRep, translatorRep] = await Promise.all([
    extractor.getReputation(extractor.did),
    reviewer.getReputation(reviewer.did),
    translator.getReputation(translator.did),
  ]);

  console.log("\n=== Final reputations, side by side ===");
  console.log(
    JSON.stringify(
      {
        extractor: { did: extractor.did, capability: "document-extraction", reputation: extractorRep },
        reviewer: { did: reviewer.did, capability: "code-review", reputation: reviewerRep },
        translator: { did: translator.did, capability: "translation.tr-en", reputation: translatorRep },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("Starter agents demo failed:", err);
  process.exitCode = 1;
});
