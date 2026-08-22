import * as db from "./db.js";
import { getAgent } from "./agentService.js";
import { listByAgent } from "./receiptService.js";
import type { Env, ReputationResult } from "./types.js";

const CONFIDENCE_SATURATION = 5;
const STAKE_NORMALIZATION_USD = 10_000;
const DECAY_HALF_LIFE_DAYS = 90;
const CONCENTRATED_COUNTERPARTY_THRESHOLD = 0.6;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function baseTrust(env: Env, agentId: string): Promise<number> {
  const agent = await db.getAgent(env, agentId);
  if (!agent) return 0.05;

  const finalized = (await listByAgent(env, agentId)).filter((r) => r.status === "finalized");
  const successCount = finalized.filter((r) => r.verification.outcome === "success").length;
  const successRatio = finalized.length > 0 ? successCount / finalized.length : 0.5;

  const stakeComponent = clamp(Math.sqrt(agent.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);
  const volumeComponent = clamp(Math.log(1 + finalized.length) / Math.log(1 + 50), 0, 1);

  return clamp(stakeComponent * 0.3 + successRatio * 0.5 + volumeComponent * 0.2, 0, 1);
}

export async function computeReputation(env: Env, agentId: string): Promise<ReputationResult> {
  const record = await getAgent(env, agentId);
  const all = await listByAgent(env, agentId);
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

  // A busy agent can have many receipts against a small set of repeat
  // counterparties — memoize baseTrust per counterparty within this one
  // computation instead of re-querying D1 once per receipt. Without this, a
  // public, unauthenticated GET /agents/:id/reputation call is a cheap way to
  // trigger O(receipts) database reads, not O(unique counterparties).
  const trustCache = new Map<string, number>();
  async function cachedBaseTrust(counterparty: string): Promise<number> {
    const cached = trustCache.get(counterparty);
    if (cached !== undefined) return cached;
    const trust = await baseTrust(env, counterparty);
    trustCache.set(counterparty, trust);
    return trust;
  }

  for (const r of finalized) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    const pairCount = pairCounts.get(counterparty) ?? 1;
    const pairWeight = Math.log(1 + pairCount) / pairCount;

    const counterpartyTrust = await cachedBaseTrust(counterparty);
    const ageDays = (Date.now() - new Date(r.result.completedAt).getTime()) / 86_400_000;
    const decay = Math.pow(2, -ageDays / DECAY_HALF_LIFE_DAYS);
    const outcomeScore = r.verification.outcome === "success" ? 1 : r.verification.outcome === "partial" ? 0.5 : 0;

    const weight = pairWeight * counterpartyTrust * decay;
    weightedSuccessSum += weight * outcomeScore;
    weightSum += weight;
    volumeUsd += Number(r.settlement?.amount ?? 0);
  }

  const successRate = weightSum > 0 ? weightedSuccessSum / weightSum : 0;
  const confidence = weightSum > 0 ? weightSum / (weightSum + CONFIDENCE_SATURATION) : 0;
  const stakeComponent = clamp(Math.sqrt(record.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);

  const trustScore = clamp(20 * stakeComponent + 70 * successRate * confidence + 10 * confidence, 0, 100);

  const flags: string[] = [];
  for (const [counterparty, count] of pairCounts.entries()) {
    if (finalized.length >= 3 && count / finalized.length > CONCENTRATED_COUNTERPARTY_THRESHOLD) {
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
      decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    },
    flags,
  };
}
