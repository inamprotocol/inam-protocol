import * as db from "./db.js";
import { getAgent } from "./agentService.js";
import { listByAgent } from "./receiptService.js";
import { hasVerifiedAttestation } from "./verificationService.js";
import { accrueVolume, roundVolumes } from "../../sdk-js/src/core/settlementVolume.js";
import { isDisputeActive, type DisputeCheckable } from "../../sdk-js/src/core/disputeLifecycle.js";
import type { Env, ReputationResult } from "./types.js";

const CONFIDENCE_SATURATION = 5;
const STAKE_NORMALIZATION_USD = 10_000;
const DECAY_HALF_LIFE_DAYS = 90;
const CONCENTRATED_COUNTERPARTY_THRESHOLD = 0.6;
// SPEC.md §12.5: a finalized, non-disputed receipt backed by at least one
// `verified` Verification counts for more.
const ATTESTATION_BOOST = 1.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// A disputed receipt whose opener never resolves it would otherwise zero out
// its reputation contribution forever at no cost — see disputeLifecycle.ts.
function countsTowardReputation(r: DisputeCheckable): boolean {
  return r.status === "finalized" || (r.status === "disputed" && !isDisputeActive(r));
}

/**
 * v0.24 — does `counterparty` have any standing independent of `excludeIds`
 * (the agent being scored, plus every counterparty *it* has ever
 * transacted with)? Used only to flag a Sybil-ring pattern the per-pair
 * wash-trading cap structurally can't catch: spreading volume across many
 * sockpuppet counterparties instead of one means no single counterparty
 * ever crosses the concentration threshold, even though none of them has
 * any transaction history outside the very cluster being scored.
 *
 * Deliberately flag-only, not a weight cap: an agent's *first-ever*
 * transaction with a brand-new, perfectly legitimate counterparty is
 * locally indistinguishable from a ring member by this one-hop check alone
 * (both have zero external history at that moment) — discounting weight on
 * this signal was tried and reverted after it zeroed out ordinary
 * few-receipt cold-start scores in testing. Real disambiguation needs
 * either a trust seed (stake, once staking ships) or multi-hop graph
 * analysis over real volume — both explicitly deferred (SPEC.md §5.2).
 *
 * `getAgent`/`listByAgent` are async here (unlike the Node reference
 * implementation) — an async predicate inside `.filter()`/`.some()`
 * silently never filters, so this walks the list with a plain loop.
 */
async function isAnchoredCounterparty(env: Env, agentId: string, excludeIds: ReadonlySet<string>): Promise<boolean> {
  const agent = await db.getAgent(env, agentId);
  if (!agent) return false;
  if (agent.stakeUsd > 0) return true;
  const receipts = (await listByAgent(env, agentId)).filter(countsTowardReputation);
  for (const r of receipts) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    if (!excludeIds.has(counterparty)) return true;
  }
  return false;
}

async function baseTrust(env: Env, agentId: string): Promise<number> {
  const agent = await db.getAgent(env, agentId);
  if (!agent) return 0.05;

  const finalized = (await listByAgent(env, agentId)).filter(countsTowardReputation);
  const successCount = finalized.filter((r) => r.verification.outcome === "success").length;
  const successRatio = finalized.length > 0 ? successCount / finalized.length : 0.5;

  const stakeComponent = clamp(Math.sqrt(agent.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);
  const volumeComponent = clamp(Math.log(1 + finalized.length) / Math.log(1 + 50), 0, 1);

  return clamp(stakeComponent * 0.3 + successRatio * 0.5 + volumeComponent * 0.2, 0, 1);
}

export async function computeReputation(env: Env, agentId: string): Promise<ReputationResult> {
  const record = await getAgent(env, agentId);
  const all = await listByAgent(env, agentId);
  const finalized = all.filter(countsTowardReputation);
  const disputedCount = all.filter((r) => isDisputeActive(r)).length;

  // Deterministic order for the wash-trading cap below: earliest-first, so a
  // counterparty's original receipts count toward trust and a later flood
  // against the same counterparty is what gets capped — not whatever order
  // the storage layer happens to return.
  finalized.sort((a, b) => new Date(a.result.completedAt).getTime() - new Date(b.result.completedAt).getTime());

  const pairCounts = new Map<string, number>();
  for (const r of finalized) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    pairCounts.set(counterparty, (pairCounts.get(counterparty) ?? 0) + 1);
  }

  // Wash-trading cap: sub-linear pair weighting below only slows growth from
  // a repeat counterparty, it never stops it — enough receipts between the
  // same two agents still push trustScore up without bound. A cap expressed
  // as a share of *this counterparty's own inflated total* (e.g.
  // floor(threshold * finalized.length)) doesn't actually stop that: the
  // attacker's flood grows finalized.length right along with it, so the cap
  // grows too. Instead each counterparty's cap is sized off the agent's
  // finalized receipts with *other* counterparties — the only volume an
  // attacker controlling just one side of the wash trade can't inflate for
  // themselves — at the same ratio (threshold / (1 - threshold)) that keeps
  // them at or under the concentrated_counterparty threshold once capped.
  // Two fresh identities with zero other history therefore get a cap of 0:
  // wash-trading alone, with no independent counterparty ever vouching for
  // either side, contributes nothing to trustScore.
  const counterpartyWeightCap = new Map<string, number>();
  if (finalized.length >= 3) {
    const capRatio = CONCENTRATED_COUNTERPARTY_THRESHOLD / (1 - CONCENTRATED_COUNTERPARTY_THRESHOLD);
    for (const [counterparty, count] of pairCounts.entries()) {
      const otherCount = finalized.length - count;
      counterpartyWeightCap.set(counterparty, Math.floor(capRatio * otherCount));
    }
  }
  const counterpartyWeightedCount = new Map<string, number>();

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
  // first-class weighted scores is P1 follow-up work, not this fix) -- it
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

  let attestedCount = 0;
  for (const r of finalized) {
    const counterparty = r.agentA.id === agentId ? r.agentB.id : r.agentA.id;
    const pairCount = pairCounts.get(counterparty) ?? 1;
    const pairWeight = Math.log(1 + pairCount) / pairCount;

    const counterpartyTrust = await cachedBaseTrust(counterparty);
    const ageDays = (Date.now() - new Date(r.result.completedAt).getTime()) / 86_400_000;
    // Clamped to [0, 1]: receiptService.createDraft now rejects a future
    // completedAt at submission time (INVALID_TIMESTAMP), but this clamp is
    // the actual fix for any receipt already stored before that check
    // existed — an audit found unclamped decay treats a future completedAt
    // as *younger than brand new* (negative ageDays -> decay > 1), inflating
    // that receipt's weight without bound rather than the intended "older
    // work counts for less, down to a floor of zero, never more than fresh".
    const decay = clamp(Math.pow(2, -ageDays / DECAY_HALF_LIFE_DAYS), 0, 1);
    const outcomeScore = r.verification.outcome === "success" ? 1 : r.verification.outcome === "partial" ? 0.5 : 0;

    // SPEC.md §12.5: independently-verified work counts for more. This loop
    // only ever sees `finalized` receipts (disputed ones already excluded by
    // the filter above), so a verified attestation on a since-disputed
    // receipt never reaches here — no separate dispute check needed.
    const isAttested = await hasVerifiedAttestation(env, r.receiptId);
    if (isAttested) attestedCount++;
    const attestationBoost = isAttested ? ATTESTATION_BOOST : 1;

    const countedSoFar = counterpartyWeightedCount.get(counterparty) ?? 0;
    const cap = counterpartyWeightCap.get(counterparty) ?? Infinity;
    let weight: number;
    if (countedSoFar >= cap) {
      weight = 0; // over the concentrated-counterparty cap — see comment above
    } else {
      weight = pairWeight * counterpartyTrust * decay * attestationBoost;
      counterpartyWeightedCount.set(counterparty, countedSoFar + 1);
    }
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
  const confidence = weightSum > 0 ? weightSum / (weightSum + CONFIDENCE_SATURATION) : 0;
  const stakeComponent = clamp(Math.sqrt(record.stakeUsd) / Math.sqrt(STAKE_NORMALIZATION_USD), 0, 1);

  const trustScore = clamp(20 * stakeComponent + 70 * successRate * confidence + 10 * confidence, 0, 100);

  const aggVolume = roundVolumes(volumeByCurrency);
  const providerVolume = roundVolumes(asProviderVolumeByCurrency);
  const requesterVolume = roundVolumes(asRequesterVolumeByCurrency);

  const flags: string[] = [];
  for (const [counterparty, count] of pairCounts.entries()) {
    if (finalized.length >= 3 && count / finalized.length > CONCENTRATED_COUNTERPARTY_THRESHOLD) {
      flags.push(`concentrated_counterparty:${counterparty}`);
    }
  }
  if (disputedCount > 0) flags.push("in_dispute");
  if (record.revokedAt) flags.push("revoked");

  // v0.24: a Sybil ring spread across many counterparties bypasses the
  // per-pair check above (no single one is concentrated) — flag when most
  // of this agent's volume comes from counterparties that themselves have
  // no transaction history outside this agent's own counterparty set. Same
  // >=3 gate and threshold as the per-pair check; see isAnchoredCounterparty
  // for why this is a flag, not a weight cap.
  if (finalized.length >= 3) {
    const excludeIds = new Set<string>([agentId, ...pairCounts.keys()]);
    let unanchoredReceiptCount = 0;
    for (const [counterparty, count] of pairCounts.entries()) {
      if (!(await isAnchoredCounterparty(env, counterparty, excludeIds))) unanchoredReceiptCount += count;
    }
    if (unanchoredReceiptCount / finalized.length > CONCENTRATED_COUNTERPARTY_THRESHOLD) {
      flags.push("unanchored_counterparty_volume");
    }
  }

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
      decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
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
