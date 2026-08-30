/**
 * Settlement-amount aggregation for the reputation model (SPEC.md §5.3).
 *
 * An audit found `components.volumeUsd` summed every finalized receipt's
 * `settlement.amount` regardless of `settlement.currency` — a 1000 TRY receipt
 * added 1000 to a field labelled USD, right next to a 10 USDC one. INAM does
 * no FX and takes no position on stablecoin pegs (§10 — payments/settlement
 * enforcement is out of scope), so the honest fix is to bucket volume by the
 * currency it was actually denominated in and never cross-sum.
 *
 * Shared by both runtimes (src/, worker/) so the two agree by construction,
 * same principle as canonical.ts / receiptContent.ts / schemas.ts.
 */

/**
 * Normalize a free-form `settlement.currency` to a bucket key. Missing or
 * blank is treated as `"USD"` — `volumeUsd` has always implicitly assumed an
 * untagged amount was USD, and receipts predating any currency discipline
 * still need to land somewhere sensible.
 */
export function normalizeCurrency(currency?: string): string {
  const c = (currency ?? "").trim().toUpperCase();
  return c === "" ? "USD" : c;
}

/**
 * Parse a `settlement.amount` string to a non-negative finite number, or 0.
 * A registry MUST NOT let a malformed or negative amount poison the running
 * volume sums (same principle as the non-finite-weight guard in §5.2) — the
 * reference schema rejects such values at ingestion, but data from a
 * non-conformant registry still flows through here.
 */
export function parseSettlementAmount(amount?: string): number {
  const n = Number(amount ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Add one receipt's settlement into a currency→total map, in place. */
export function accrueVolume(
  byCurrency: Record<string, number>,
  settlement?: { amount?: string; currency?: string },
): void {
  const amount = parseSettlementAmount(settlement?.amount);
  if (amount === 0) return;
  const key = normalizeCurrency(settlement?.currency);
  byCurrency[key] = (byCurrency[key] ?? 0) + amount;
}

/** Round every bucket to 2 decimal places — these are money totals, not raw
 *  floats, and `0.1 + 0.2` should not surface in an API response. */
export function roundVolumes(byCurrency: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(byCurrency)) out[k] = Math.round(v * 100) / 100;
  return out;
}
