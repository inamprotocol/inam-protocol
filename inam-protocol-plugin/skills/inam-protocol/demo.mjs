#!/usr/bin/env node
// Self-contained INAM Protocol demo: registers two fresh identities against a
// registry, completes one job -> receipt -> reputation update, prints the
// result, then revokes both identities. Revocation is one-way and additive:
// it drops the identity from default `search` results but the finalized
// receipt it produced stays on the record permanently (SPEC.md sec 2.2).
//
// Defaults to a LOCAL dev server (safe, throwaway). Writing to any other
// registry (e.g. the live one) needs TWO explicit env vars, not one -- see
// below -- so a stray/mistaken env var can't silently point this at prod.
//
// Cleanup (revoke) is best-effort for BOTH identities no matter where the
// demo fails, via try/finally: a mid-run crash (rate limit, network blip,
// server error) must not leave an orphaned, unrevoked identity sitting on
// whatever registry this ran against.
//
// Usage:
//   npm run dev                                          # in the repo root, starts :4021
//   node demo.mjs                                        # against local dev server (default)
//   INAM_URL=https://api.inamprotocol.org INAM_CONFIRM=yes node demo.mjs
//                                                         # opt-in: real registry, real signal
import { InamClient, generateKeypair, sha256Hex } from "inamprotocol";

const BASE_URL = process.env.INAM_URL ?? "http://localhost:4021";
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL);

if (!isLocal && process.env.INAM_CONFIRM !== "yes") {
  console.error(
    `Refusing to run: ${BASE_URL} is not a local dev server.\n` +
      `This would write real, signed records to a live registry someone else operates.\n` +
      `If that's actually what you want, re-run with INAM_CONFIRM=yes set as well.`,
  );
  process.exit(1);
}

const provider = new InamClient(BASE_URL, generateKeypair());
const requester = new InamClient(BASE_URL, generateKeypair());
let providerRegistered = false;
let requesterRegistered = false;

console.log(`INAM demo against ${BASE_URL}`);
console.log(`provider:  ${provider.did}`);
console.log(`requester: ${requester.did}\n`);

try {
  await provider.registerAgent(["demo.skill-trial"], { demo: true, name: "Skill demo provider" });
  providerRegistered = true;
  await requester.registerAgent(["job.posting"], { demo: true, name: "Skill demo requester" });
  requesterRegistered = true;

  const specHash = `sha256:${sha256Hex("Say hello from the INAM skill demo.")}`;
  const outputHash = `sha256:${sha256Hex("hello from the INAM skill demo")}`;
  const job = await requester.postJob({ capability: "demo.skill-trial", specHash });
  console.log("job posted:", job.jobId);

  await provider.submitOffer(job.jobId, "trying out the INAM skill");
  await requester.acceptOffer(job.jobId, provider.did);
  console.log("offer accepted");

  const now = new Date().toISOString();
  const draft = await provider.submitWork(requester.did, {
    jobId: job.jobId,
    task: { capability: "demo.skill-trial", specHash, createdAt: now },
    result: { outputHash, completedAt: now },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  console.log("draft receipt:", draft.receiptId);

  const final = await requester.acceptWork(draft, { jobId: job.jobId, outputHash });
  console.log("finalized:", final.status);

  const rep = await provider.getReputation(provider.did);
  console.log("\nprovider reputation after one finalized receipt:");
  console.log(JSON.stringify(rep, null, 2));
  console.log(`\nreceipt id: ${final.receiptId}`);
} finally {
  // Best-effort cleanup: revoke whichever identities actually got registered,
  // even if an earlier step threw. Errors here are reported but not re-thrown
  // -- a failed revoke shouldn't mask the original error, and there's nothing
  // more this script can do about it.
  const cleanups = [];
  if (providerRegistered) cleanups.push(["provider", provider]);
  if (requesterRegistered) cleanups.push(["requester", requester]);
  for (const [label, client] of cleanups) {
    try {
      await client.revoke("skill demo cleanup");
      console.log(`revoked ${label} identity (${client.did})`);
    } catch (err) {
      console.error(`WARNING: failed to revoke ${label} identity (${client.did}): ${err.message}`);
    }
  }
}
