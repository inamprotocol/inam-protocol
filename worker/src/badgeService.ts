import type { ReputationResult } from "./types.js";

/**
 * Renders a shields.io-style "inam" reputation badge — a read-only, unsigned,
 * public rendering layer on top of computeReputation()'s output. This file
 * never scores anything itself; it only maps an already-computed
 * ReputationResult (or the absence of one) to a small set of fixed strings
 * and colors.
 *
 * Deliberately duplicated from src/services/badgeService.ts rather than shared,
 * matching this repo's existing convention for reputationService.ts itself
 * (see root README: "kept behaviorally identical" — verified by running both
 * runtimes and diffing output, not by sharing non-crypto code across them).
 */

// Score bands (0-100, same scale as ReputationResult.trustScore):
//   >= 70  -> green   ("high" trust, plenty of successful, trust-weighted history)
//   >= 40  -> yellow  ("moderate" trust)
//   <  40  -> red     ("low" trust — including a real, earned 0 from an agent
//                       with history but a poor track record)
// A brand-new agent with *no* finalized receipts yet is NOT put in the red
// band even though its trustScore is 0 — README's "Reading the demo output"
// section is explicit that a low first score is expected, not bad, so a
// zero-history agent gets its own neutral grey "new" badge instead of
// visually implying it has been judged and found wanting.
const COLOR_HIGH = "#4c1";
const COLOR_MID = "#dfb317";
const COLOR_LOW = "#e05d44";
const COLOR_NEW = "#9f9f9f";
const COLOR_NOT_FOUND = "#9f9f9f";

const SCORE_HIGH_THRESHOLD = 70;
const SCORE_MID_THRESHOLD = 40;

export interface BadgeData {
  /** Always the fixed literal "inam" — never agent-supplied text. */
  label: string;
  /** Always one of: a formatted trustScore, "new", or "unknown" — never agent-supplied text. */
  value: string;
  /** CSS hex color, with leading '#'. */
  color: string;
  status: "scored" | "new" | "not_found";
  trustScore?: number;
}

function formatScore(score: number): string {
  // trustScore is already rounded to 1 decimal by computeReputation().
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

/**
 * Builds badge data for a *found* agent. `rep.components.verifiedReceipts`
 * (finalized, two-party receipts) is the "zero history" signal — more
 * precise than trustScore === 0 alone, since a staked-but-historyless agent
 * could theoretically have a nonzero score with zero receipts, and this repo
 * doesn't currently expose a way to post stake anyway (see README "Deliberate
 * simplifications"), so in practice the two conditions coincide.
 */
export function badgeDataForReputation(rep: ReputationResult): BadgeData {
  const hasHistory = rep.components.verifiedReceipts > 0;
  if (!hasHistory) {
    return { label: "inam", value: "new", color: COLOR_NEW, status: "new", trustScore: rep.trustScore };
  }
  const score = rep.trustScore;
  const color = score >= SCORE_HIGH_THRESHOLD ? COLOR_HIGH : score >= SCORE_MID_THRESHOLD ? COLOR_MID : COLOR_LOW;
  return { label: "inam", value: formatScore(score), color, status: "scored", trustScore: score };
}

/** Badge data for an unknown/unregistered `did:key` — never a broken image. */
export function notFoundBadgeData(): BadgeData {
  return { label: "inam", value: "unknown", color: COLOR_NOT_FOUND, status: "not_found" };
}

// Approximate Verdana/DejaVu-Sans 11px advance widths (px), covering exactly
// the fixed character set this module ever renders ("inam", digits, ".",
// "new", "unknown"). Not pixel-perfect shields.io parity, just consistent —
// there's no canvas/DOM text-measurement API available in the Workers
// runtime, so a small hardcoded table (rather than measureText) is the
// approach that actually works in both runtimes.
const CHAR_WIDTHS: Record<string, number> = {
  i: 4,
  n: 7,
  a: 7,
  m: 10,
  e: 7,
  w: 9,
  u: 7,
  k: 6,
  o: 7,
  "0": 7,
  "1": 7,
  "2": 7,
  "3": 7,
  "4": 7,
  "5": 7,
  "6": 7,
  "7": 7,
  "8": 7,
  "9": 7,
  ".": 4,
};
const DEFAULT_CHAR_WIDTH = 7;
const H_PADDING = 10; // total horizontal padding added to a segment's text width

function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += CHAR_WIDTHS[ch] ?? DEFAULT_CHAR_WIDTH;
  return w;
}

// SVG is XML: even though label/value here are always drawn from the small
// fixed set above (never agent-supplied free text like metadata.name — see
// badgeDataForReputation/notFoundBadgeData), this escapes anyway as
// defense-in-depth rather than relying on "it happens to be safe today".
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** shields.io "flat"-style badge: a grey "inam" label segment + a color-coded value segment. */
export function renderBadgeSvg(data: BadgeData): string {
  const label = escapeXml(data.label);
  const value = escapeXml(data.value);
  const labelW = textWidth(data.label) + H_PADDING;
  const valueW = textWidth(data.value) + H_PADDING;
  const totalW = labelW + valueW;
  const labelX = labelW / 2;
  const valueX = labelW + valueW / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${value}">
<linearGradient id="s" x2="0" y2="100%">
<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
<stop offset="1" stop-opacity=".1"/>
</linearGradient>
<mask id="m"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></mask>
<g mask="url(#m)">
<rect width="${labelW}" height="20" fill="#555"/>
<rect x="${labelW}" width="${valueW}" height="20" fill="${data.color}"/>
<rect width="${totalW}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
<text x="${labelX}" y="14">${label}</text>
<text x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
<text x="${valueX}" y="14">${value}</text>
</g>
</svg>`;
}

/**
 * JSON shape follows shields.io's "endpoint badge" schema
 * (schemaVersion/label/message/color) so this same badge.json response can
 * optionally be pointed to directly from shields.io itself
 * (`https://img.shields.io/endpoint?url=<badge.json URL>`), plus extra
 * `status`/`trustScore` fields for anyone building their own renderer.
 */
export function badgeDataToJson(data: BadgeData) {
  return {
    schemaVersion: 1,
    label: data.label,
    message: data.value,
    color: data.color.replace(/^#/, ""),
    status: data.status,
    ...(data.trustScore !== undefined ? { trustScore: data.trustScore } : {}),
  };
}
