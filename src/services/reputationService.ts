import { config } from "../config.js";
import { getAgent } from "./agentService.js";
import { listByAgent } from "./receiptService.js";
import { hasVerifiedAttestation } from "./verificationService.js";
import { accrueVolume, roundVolumes } from "../../sdk-js/src/core/settlementVolume.js";
import type { ReputationResult } from "../types.js";

const CONFIDENCE_SATURATION = 5; // weight units at which confidence ~= 0.5
const STAKE_NORMALIZATION_USD = 10_000; // stake at which the stake component saturates to 1.0
// SPEC.md §12.5: a finalized, non-disputed receipt backed by at least one
// `verified` Verification counts for more. Fixed multiplier, not tunable per
// registry in the reference implementation — a registry MAY choose its own
// as long as independently-verified work counts for more, never less.
const ATTESTATION_BOOST = 1.5;

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
  // Volume bucketed by settlement currency, never cross-summed — an audit
  // found the old single `volumeUsd` added TRY/EUR/USDC amounts together as
  // raw USD. INAM does no FX (SPEC.md §10), so `volumeUsd` below is just the
  // "USD" bucket; everything else stays visible only in volumeByCurrency.
  const volumeByCurrency: Record<string, number> = {};

  // Role breakdown: an audit found the aggregate trustScore/components above
  // don't distinguish "did the work" (agentB/provider) from "requested and
  // paid for the work" (agentA/requester) at all -- two brand-new agents
  // that transact once end up with identical-looking reputations regardless
  // of which side of the receipt each was on, since nothing in the formula
  // is role-aware. This doesn't replace trustScore (that would be a real
  // scoring-model redesign -- providerScore/requesterScore/verifierScore as
  // first-class weighted scores is P1 follow-up work, not this fix) --  it
  // exposes the role-split raw signal (receipt count / weighted success rate
  // / volume) that already existed per-receipt but was being silently merged
  // together, using the same weighting (pairWeight * counterpartyTrust *
  // decay * attestationBoost) as the aggregate above, just filtered by role.
  let asProviderWeightedSuccessSum = 0;
  let asProviderWeightSum = 0;
  const asProviderVolumeByCurrency: Record<string, number> = {};
  let asProviderCount = 0;
  let asRequesterWeightedSuccessSum = 0;
  let asRequesterWeightSum = 0;
  const asRequesterVolumeByCurrency: Record<string, number> = {};
  let asRequesterCount = 0;

  // Memoize per counterparty within this one computation — a busy agent can
  // have many receipts against a small set of repeat counterparties, and
  // there's no reason to recompute the same counterparty's baseTrust for
  // every one of them.
  const trustCache = new Map<string, number>();
  function cachedBaseTrust(counterparty: string): number {
    const cached = trustCache.get(counterparty);
    if (cached !== undefined) return cached;
    const trust = baseTrust(counterparty);
    trustCache.set(counterparty, trust);
    return trust;
  }

  let attestedCount = 0;
  for (const r of finalized) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    const pairCount = pairCounts.get(counterparty) ?? 1;
    // Sub-linear pair weight: total contribution from one counterparty grows
    // with log(pairCount), not linearly — repeated wash-trading-style
    // receipts between the same two agents saturate instead of compounding.
    const pairWeight = Math.log(1 + pairCount) / pairCount;

    const counterpartyTrust = cachedBaseTrust(counterparty);
    const ageDays = (Date.now() - new Date(r.result.completedAt).getTime()) / 86_400_000;
    // Clamped to [0, 1]: receiptService.createDraft now rejects a future
    // completedAt at submission time (INVALID_TIMESTAMP), but this clamp is
    // the actual fix for any receipt already stored before that check
    // existed — an audit found unclamped decay treats a future completedAt
    // as *younger than brand new* (negative ageDays -> decay > 1), inflating
    // that receipt's weight without bound rather than the intended "older
    // work counts for less, down to a floor of zero, never more than fresh".
    const decay = clamp(Math.pow(2, -ageDays / config.decayHalfLifeDays), 0, 1);
    const outcomeScore = r.verification.outcome === "success" ? 1 : r.verification.outcome === "partial" ? 0.5 : 0;

    // SPEC.md §12.5: independently-verified work counts for more. This loop
    // only ever sees `finalized` receipts (disputed ones already excluded by
    // the filter above), so a verified attestation on a since-disputed
    // receipt never reaches here — no separate dispute check needed.
    const isAttested = hasVerifiedAttestation(r.receiptId);
    if (isAttested) attestedCount++;
    const attestationBoost = isAttested ? ATTESTATION_BOOST : 1;

    let weight = pairWeight * counterpartyTrust * decay * attestationBoost;
    // Defense in depth against any other source of a non-finite weight (a
    // malformed completedAt predating the INVALID_TIMESTAMP check above, a
    // future edge case) corrupting this agent's *entire* score: `weightSum
    // += NaN` poisons the running total for every other, perfectly valid
    // receipt too, not just this one. Treat it as zero contribution instead
    // of let it propagate.
    if (!Number.isFinite(weight)) weight = 0;
    weightedSuccessSum += weight * outcomeScore;
    weightSum += weight;
    accrueVolume(volumeByCurrency, r.settlement);

    if (r.agentB.id === agentId) {
      asProviderWeightedSuccessSum += weight * outcomeScore;
      asProviderWeightSum += weight;
      accrueVolume(asProviderVolumeByCurrency, r.settlement);
      asProviderCount++;
    } else {
      asRequesterWeightedSuccessSum += weight * outcomeScore;
      asRequesterWeightSum += weight;
      accrueVolume(asRequesterVolumeByCurrency, r.settlement);
      asRequesterCount++;
    }
  }

  const successRate = weightSum > 0 ? weightedSuccessSum / weightSum : 0;
  // "Confidence" — how much accumulated, trust-weighted history backs this
  // score. Saturates toward 1 as weight grows; a single lucky receipt with a
  // low-trust counterparty barely moves it.
  const confidence = weightSum > 0 ? weightSum / (weightSum + CONFIDENCE_SATURATION) : 0;
  const stakeComponent = clamp(Math.sqrt(record.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);

  const trustScore = clamp(20 * stakeComponent + 70 * successRate * confidence + 10 * confidence, 0, 100);

  const aggVolume = roundVolumes(volumeByCurrency);
  const providerVolume = roundVolumes(asProviderVolumeByCurrency);
  const requesterVolume = roundVolumes(asRequesterVolumeByCurrency);

  const flags: string[] = [];
  for (const [counterparty, count] of pairCounts.entries()) {
    if (finalized.length >= 3 && count / finalized.length > config.concentratedCounterpartyThreshold) {
      flags.push(`concentrated_counterparty:${counterparty}`);
    }
  }
  if (disputedCount > 0) flags.push("in_dispute");
  if (record.revokedAt) flags.push("revoked");

  return {
    trustScore: Math.round(trustScore * 10) / 10,
    components: {
      eigenWeight: Math.round(confidence * 1000) / 1000,
      verifiedReceipts: finalized.length,
      rawReceipts: all.length,
      successRate: Math.round(successRate * 1000) / 1000,
      volumeUsd: aggVolume.USD ?? 0,
      volumeByCurrency: aggVolume,
      stakeUsd: record.stakeUsd,
      decayHalfLifeDays: config.decayHalfLifeDays,
      attestedReceipts: attestedCount,
      asProvider: {
        receipts: asProviderCount,
        successRate: asProviderWeightSum > 0 ? Math.round((asProviderWeightedSuccessSum / asProviderWeightSum) * 1000) / 1000 : 0,
        volumeUsd: providerVolume.USD ?? 0,
        volumeByCurrency: providerVolume,
      },
      asRequester: {
        receipts: asRequesterCount,
        successRate: asRequesterWeightSum > 0 ? Math.round((asRequesterWeightedSuccessSum / asRequesterWeightSum) * 1000) / 1000 : 0,
        volumeUsd: requesterVolume.USD ?? 0,
        volumeByCurrency: requesterVolume,
      },
    },
    flags,
  };
}
