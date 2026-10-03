import type { InamClient } from "./client.js";
import type { AgentRecord, ReputationResult } from "./types.js";
import { policyFailure, type X402Policy } from "./x402.js";

/** A decision-ready trust check: allow, escrow, or deny, with the reasons.
 *
 * Runs on the caller's side from the registry's appraisal, which is a hint
 * (SPEC.md §5.4); the registry never decides for you. "escrow" means: deal,
 * but don't release payment until delivery is confirmed. INAM holds no money,
 * so the escrow itself is the caller's rail (x402, a wallet allow list, etc.). */

export type TrustDecisionKind = "allow" | "escrow" | "deny";

export interface TrustPolicy {
  /** Bar for "allow". Default: independently verified evidence, any score. Countersigned-only history is the two parties' own word (THREAT-MODEL.md), so by default it gets escrow. */
  allow?: X402Policy;
  /** Bar for "escrow"; below it is "deny". Default: no evidence needed, so unknown agents get escrow. */
  escrow?: X402Policy;
  /** Reputation flags that cap the decision at "escrow" (prefix match, so `concentrated_counterparty` matches its `:did` suffix). */
  escrowFlags?: string[];
}

export interface TrustDecision {
  decision: TrustDecisionKind;
  reasons: string[];
  did: string;
  reputation?: ReputationResult;
}

export const DEFAULT_ESCROW_FLAGS = ["in_dispute", "attestation_rejected", "nonperformance_reported", "concentrated_counterparty"];

/** Pure policy check, for callers that already fetched the agent and its reputation. */
export function decideTrust(agent: AgentRecord, reputation: ReputationResult, policy: TrustPolicy = {}): TrustDecision {
  const base = { did: agent.id, reputation };
  if (agent.revokedAt) return { ...base, decision: "deny", reasons: ["INAM ID is revoked"] };

  const escrowMiss = policyFailure(reputation, { minEvidence: "none", ...policy.escrow });
  if (escrowMiss) return { ...base, decision: "deny", reasons: [escrowMiss] };

  const reasons: string[] = [];
  const allowMiss = policyFailure(reputation, { minEvidence: "independently_verified", ...policy.allow });
  if (allowMiss) reasons.push(allowMiss);
  const watch = policy.escrowFlags ?? DEFAULT_ESCROW_FLAGS;
  for (const f of reputation.flags ?? []) if (watch.some((w) => f === w || f.startsWith(`${w}:`))) reasons.push(`flag ${f}`);

  if (reasons.length) return { ...base, decision: "escrow", reasons };
  return { ...base, decision: "allow", reasons: [`evidence ${reputation.evidenceLevel}, trustScore ${reputation.trustScore}`] };
}

/** Fetches `did` from the registry `inam` points at and decides. An ID the registry doesn't know is "deny". */
export async function checkTrust(did: string, inam: InamClient, policy: TrustPolicy = {}): Promise<TrustDecision> {
  let agent: AgentRecord, reputation: ReputationResult;
  try {
    [agent, reputation] = await Promise.all([inam.getAgent(did), inam.getReputation(did)]);
  } catch {
    return { did, decision: "deny", reasons: ["INAM ID not found in the registry"] };
  }
  return decideTrust(agent, reputation, policy);
}
