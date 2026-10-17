// GET /v1/stats: an evidence breakdown of the whole registry, so a headline
// receipt count can be read next to how much of it is demo traffic, how much
// is maintainer-only, and how much is countersigned, verified or paid.
// Counts only; no receipt content, so participants_only receipts are counted
// too (their existence is not secret, SPEC.md §4.4).
import { fromHex, keypairFromPrivateKey } from "../../sdk-js/src/crypto/keys.js";
import { DEMO_CAPABILITY_PREFIX } from "../../sdk-js/src/core/demo.js";
import * as db from "./db.js";
import type { Env, ExecutionReceipt } from "./types.js";

/** Agents the maintainers run, named in repository docs (GOVERNANCE.md,
 * README.md, sdk-js/README.md). Explicit on purpose: "operator agent" is never
 * inferred from names, timing or behaviour. Add a DID here when the
 * maintainers start running another agent. */
export const MAINTAINER_AGENT_IDS: readonly string[] = [
  "did:key:z6MkoERaG7ttjBvSbEsEFx7mdd7BKvntqrESqosxPSHLxe5F", // INAM Integrity Verifier (GOVERNANCE.md)
  "did:key:z6MkjE6iZEFoKkBoxR3QygfWaFUkLUUkj1ry527tUWQB8Gpk", // Reference Reviewer (README.md)
  "did:key:z6MkpSvw1Yuc3ReWhCmt5RwY5LVZqMRY9p8NvpA2TSQCPPyK", // Reference Extractor (sdk-js/README.md)
  "did:key:z6MkrdaWFKVAgrJAB4fM8o5NPgwkM7uWXHnx3bg87Xos8HXy", // INAM service ID (linked wallet 0x8BCd93d094BB0B995f5E8D81568431875252E01e is the maintainers')
  // Maintainers' own test/smoke agents (found 17 Oct by reading the registry; none is an outside user).
  "did:key:z6MkoEDhSMwK6uDsrvBrBs9kfJs39SRwahybe6vsuUUUs2DN", // 22 Sep prod smoke test (job_prodlive_*) requester
  "did:key:z6MkqkWegxNygaJHCQjN47eVZoJS2H1gKaFYWuL4SgcR18PX", // 22 Sep prod smoke test worker
  "did:key:z6Mkf7s7aQc26UCBfqVyb2EjaPFgJvzgks5dhdWq8ipHYNDP", // 9 Oct live test: HTTP receipts worker
  "did:key:z6MksCiVRFc3zNJJ9xWzgGph7VPcrbPrEzPHnzQjAVV2EtKD", // 9 Oct live test: HTTP receipts requester
  "did:key:z6MksGBaGCj5LUt1hrAXonzPvqWxFhUE16Pc2TUz7X2Z3VNR", // 10 Oct quickstart verification run
  "did:key:z6MkvYBn8nM22N7QnfLEEmK72ewkCk8VnPitQ7f9pifRxzMM", // 10 Oct quickstart verification run (python)
  "did:key:z6MkoGNs9969z1nYHBMNqBrPNTeaGaHjyT8PhYyeXou5se4S", // 10 Oct quickstart verification run
  "did:key:z6MkgCPs6QFa9Mpr7PbrdebLPD1Z6xTLAZmQabn138zbAS8W", // 10 Oct quickstart verification run (python)
  "did:key:z6MkqoAm5q9AZQvgK8QXVwBSRtMGeqyHrgymvK6chAyuw7bf", // 17 Oct link-wallet test (x402 seller)
];

const DAY_MS = 86_400_000;

// ponytail: full-table scans of agents/receipts/verifications/log, fine at
// today's size and cached 5 min by the route; move to SQL aggregates when
// the registry outgrows one request's memory.
export async function computeStats(env: Env, now = Date.now()) {
  const [agents, receiptRows, verificationRows, logRows] = await Promise.all([
    db.allAgents(env),
    env.DB.prepare("SELECT data FROM receipts").all<{ data: string }>(),
    env.DB.prepare("SELECT receipt_id, verifier, result FROM verifications").all<{ receipt_id: string; verifier: string; result: string }>(),
    env.DB.prepare("SELECT entry_type, created_at FROM transparency_log").all<{ entry_type: string; created_at: string }>(),
  ]);
  const byId = new Map(agents.map((a) => [a.id, a]));

  const operator = new Set(MAINTAINER_AGENT_IDS);
  if (env.OPERATOR_DID) operator.add(env.OPERATOR_DID);
  const demoDid = env.DEMO_PRIVATE_KEY ? keypairFromPrivateKey(fromHex(env.DEMO_PRIVATE_KEY)).did : undefined;
  if (demoDid) operator.add(demoDid);
  // SPEC.md §2: metadata.reference marks a maintainer-seeded agent. Self-declared,
  // so it can only move an agent *into* this set, never out of it.
  for (const a of agents) if (a.metadata?.reference === true) operator.add(a.id);

  // Same filter as attestationVerdict (§12.5): only currently authorized, non-revoked verifiers.
  const verifiedBy = new Map<string, string[]>();
  for (const v of verificationRows.results) {
    const verifier = byId.get(v.verifier);
    if (v.result !== "verified" || !verifier?.isAuthorizedVerifier || verifier.revokedAt || verifier.succeededBy) continue;
    verifiedBy.set(v.receipt_id, [...(verifiedBy.get(v.receipt_id) ?? []), v.verifier]);
  }

  const receipts: ExecutionReceipt[] = receiptRows.results.map((r) => JSON.parse(r.data));
  const signed = receipts.filter((r) => r.status !== "draft");
  const flagged = (id: string) => byId.get(id)?.metadata?.demo === true || byId.get(id)?.metadata?.test === true;
  const isDemo = (r: ExecutionReceipt) => r.task.capability.startsWith(DEMO_CAPABILITY_PREFIX) || r.agentA.id === demoDid || r.agentB.id === demoDid;
  const isLabelled = (r: ExecutionReceipt) => isDemo(r) || r.task.capability.startsWith("test.") || flagged(r.agentA.id) || flagged(r.agentB.id);
  const operatorOnly = (r: ExecutionReceipt) => operator.has(r.agentA.id) && operator.has(r.agentB.id);
  const isIndependent = (id: string) => !operator.has(id) && !flagged(id);
  const independentReceipt = (r: ExecutionReceipt) =>
    r.status === "finalized" && !isLabelled(r) && r.agentA.id !== r.agentB.id && isIndependent(r.agentA.id) && isIndependent(r.agentB.id);
  const linkedAgents = agents.filter((a) => !!a.linked?.erc8004_id);
  const count = (pred: (r: ExecutionReceipt) => boolean) => signed.filter(pred).length;

  const logged = logRows.results.filter((e) => e.entry_type === "receipt_finalized");
  const since = (days: number) => logged.filter((e) => now - Date.parse(e.created_at) <= days * DAY_MS).length;

  return {
    generatedAt: new Date(now).toISOString(),
    transparencyLog: { entries: logRows.results.length, receiptsFinalized: logged.length, last7Days: since(7), last30Days: since(30) },
    receipts: {
      drafts: receipts.length - signed.length,
      countersigned: signed.length,
      disputed: count((r) => r.status === "disputed"),
      withPaymentRef: count((r) => !!r.settlement?.paymentRef),
      withVerifiedAttestation: count((r) => verifiedBy.has(r.receiptId)),
      withVerifiedAttestationByNonOperator: count((r) => (verifiedBy.get(r.receiptId) ?? []).some((v) => !operator.has(v))),
      demo: count(isDemo),
      labelledTestOrDemo: count(isLabelled),
      operatorOnly: count(operatorOnly),
      unlabelledWithNonOperatorParty: count((r) => !isLabelled(r) && !operatorOnly(r)),
    },
    agents: {
      registered: agents.length,
      inCountersignedReceipts: new Set(signed.flatMap((r) => [r.agentA.id, r.agentB.id])).size,
    },
    nonOperatorAgents: agents.filter((a) => isIndependent(a.id)).length,
    linkedWallets: {
      total: linkedAgents.length,
      operator: linkedAgents.filter((a) => !isIndependent(a.id)).length,
      nonOperator: linkedAgents.filter((a) => isIndependent(a.id)).length,
    },
    countersignedReceiptsBetweenIndependentParties: count(independentReceipt),
    definitions: {
      nonOperatorAgent: "registered agent that is not an operator agent (operatorAgents) and does not self-declare metadata.demo or metadata.test. Self-declared flags can only exclude an agent, never include one.",
      linkedWallet: "agent whose linked.erc8004_id is set; that field is only written after a challenge signed by the wallet's secp256k1 key (SPEC.md §2.1). Split by the same operator test as nonOperatorAgent.",
      independentReceipt: "status finalized (both signatures verified; disputed excluded), not demo/test labelled (demo.* or test.* capability, demo agent, metadata.demo/test), and both parties are different nonOperatorAgents. Independence is by registry identity only: one person running two did:keys still counts, and is not detectable here.",
    },
    counterpartyPairs: new Set(signed.map((r) => [r.agentA.id, r.agentB.id].sort().join(" "))).size,
    operatorAgents: [...operator].sort(),
  };
}
