import { config } from "../config.js";
import { getAgent } from "./agentService.js";
import { listByAgent } from "./receiptService.js";
import type { ReputationResult } from "../types.js";

const CONFIDENCE_SATURATION = 5; // weight units at which confidence ~= 0.5
const STAKE_NORMALIZATION_USD = 10_000; // stake at which the stake component saturates to 1.0

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * A cheap, non-recursive trust estimate used only as *another agent's*
 * counterparty weight when scoring someone else's receipts. Deliberately not
 * the full computeReputation() below, to avoid unbounded mutual recursion —
 * this is the documented simplification of a full EigenTrust-style
 * fixed-point solve; upgrading to iterative power-iteration over the whole
 * interaction graph is the natural next step once there's enough volume for
 * it to matter.
 */
function baseTrust(agentId: string): number {
  const agent = (() => {
    try {
      return getAgent(agentId);
    } catch {
      return undefined;
    }
  })();
  if (!agent) return 0.05; // unregistered/unknown counterparty: minimal, not zero, trust

  const finalized = listByAgent(agentId).filter((r) => r.status === "finalized");
  const successCount = finalized.filter((r) => r.verification.outcome === "success").length;
  const successRatio = finalized.length > 0 ? successCount / finalized.length : 0.5; // neutral prior for a brand-new agent

  const stakeComponent = clamp(Math.sqrt(agent.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);
  const volumeComponent = clamp(Math.log(1 + finalized.length) / Math.log(1 + 50), 0, 1);

  return clamp(stakeComponent * 0.3 + successRatio * 0.5 + volumeComponent * 0.2, 0, 1);
}

export function computeReputation(agentId: string): ReputationResult {
  const record = getAgent(agentId);
  const all = listByAgent(agentId);
  const finalized = all.filter((r) => r.status === "finalized");
  const disputedCount = all.filter((r) => r.status === "disputed").length;

  const pairCounts = new Map<string, number>();
  for (const r of finalized) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    pairCounts.set(counterparty, (pairCounts.get(counterparty) ?? 0) + 1);
  }

  let weightedSuccessSum = 0;
  let weightSum = 0;
  let volumeUsd = 0;

  for (const r of finalized) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    const pairCount = pairCounts.get(counterparty) ?? 1;
    // Sub-linear pair weight: total contribution from one counterparty grows
    // with log(pairCount), not linearly — repeated wash-trading-style
    // receipts between the same two agents saturate instead of compounding.
    const pairWeight = Math.log(1 + pairCount) / pairCount;

    const counterpartyTrust = baseTrust(counterparty);
    const ageDays = (Date.now() - new Date(r.result.completedAt).getTime()) / 86_400_000;
    const decay = Math.pow(2, -ageDays / config.decayHalfLifeDays);
    const outcomeScore = r.verification.outcome === "success" ? 1 : r.verification.outcome === "partial" ? 0.5 : 0;

    const weight = pairWeight * counterpartyTrust * decay;
    weightedSuccessSum += weight * outcomeScore;
    weightSum += weight;
    volumeUsd += Number(r.settlement?.amount ?? 0);
  }

  const successRate = weightSum > 0 ? weightedSuccessSum / weightSum : 0;
  // "Confidence" — how much accumulated, trust-weighted history backs this
  // score. Saturates toward 1 as weight grows; a single lucky receipt with a
  // low-trust counterparty barely moves it.
  const confidence = weightSum > 0 ? weightSum / (weightSum + CONFIDENCE_SATURATION) : 0;
  const stakeComponent = clamp(Math.sqrt(record.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);

  const trustScore = clamp(20 * stakeComponent + 70 * successRate * confidence + 10 * confidence, 0, 100);

  const flags: string[] = [];
  for (const [counterparty, count] of pairCounts.entries()) {
    if (finalized.length >= 3 && count / finalized.length > config.concentratedCounterpartyThreshold) {
      flags.push(`concentrated_counterparty:${counterparty}`);
    }
  }
  if (disputedCount > 0) flags.push("in_dispute");

  return {
    trustScore: Math.round(trustScore * 10) / 10,
    components: {
      eigenWeight: Math.round(confidence * 1000) / 1000,
      verifiedReceipts: finalized.length,
      rawReceipts: all.length,
      successRate: Math.round(successRate * 1000) / 1000,
      volumeUsd,
      stakeUsd: record.stakeUsd,
      decayHalfLifeDays: config.decayHalfLifeDays,
    },
    flags,
  };
}
