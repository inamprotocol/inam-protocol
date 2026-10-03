import type { InamClient } from "./client.js";
import type { AgentRecord, ReputationResult } from "./types.js";
import type { EvidenceLevel } from "./core/attestation.js";

/** "Verify before you pay" for x402 v2 (SPEC.md §11.2).
 *
 * A paid resource names its INAM ID in the 402's `extensions.inam`. Before any
 * payment is signed, the gate checks that this ID proved control of the
 * `payTo` address (`linked.erc8004_id`, SPEC.md §2.1), and that its
 * reputation meets the caller's policy. Without that binding a server could
 * borrow a reputable agent's DID while routing the money elsewhere. */

export const INAM_X402_EXTENSION = "inam";

export interface X402Policy {
  /** Minimum `trustScore` (0-100, SPEC.md §5.3). Default 0. */
  minTrustScore?: number;
  /** Minimum evidence behind the history. Default "countersigned". */
  minEvidence?: EvidenceLevel;
}

export interface X402Decision {
  allow: boolean;
  reason: string;
  did?: string;
  reputation?: ReputationResult;
}

const EVIDENCE_RANK: Record<EvidenceLevel, number> = { none: 0, countersigned: 1, independently_verified: 2 };

/** The `extensions` entry a paid server adds to its PaymentRequired object. */
export function inamX402Extension(did: string) {
  return {
    [INAM_X402_EXTENSION]: {
      info: { did },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { did: { type: "string", pattern: "^did:key:" } },
        required: ["did"],
      },
    },
  };
}

/** Pure policy check, usable without the fetch wrapper. */
export function decideX402(agent: AgentRecord, reputation: ReputationResult, payTo: string[], policy: X402Policy = {}): X402Decision {
  const base = { did: agent.id, reputation };
  if (agent.revokedAt) return { ...base, allow: false, reason: "payee INAM ID is revoked" };
  const bound = agent.linked.erc8004_id?.toLowerCase();
  if (!bound || !payTo.some((a) => a.toLowerCase() === bound)) {
    return { ...base, allow: false, reason: "payTo is not an address this INAM ID proved control of" };
  }
  const failed = policyFailure(reputation, policy);
  return failed ? { ...base, allow: false, reason: failed } : { ...base, allow: true, reason: "ok" };
}

/** Why `reputation` misses `policy`, or null if it meets it. Shared with the A2A check (§11.3). */
export function policyFailure(reputation: ReputationResult, policy: X402Policy = {}): string | null {
  const minEvidence = policy.minEvidence ?? "countersigned";
  if (EVIDENCE_RANK[reputation.evidenceLevel] < EVIDENCE_RANK[minEvidence]) return `evidence ${reputation.evidenceLevel} is below ${minEvidence}`;
  if (reputation.trustScore < (policy.minTrustScore ?? 0)) return `trustScore ${reputation.trustScore} is below ${policy.minTrustScore}`;
  return null;
}

export class X402PaymentBlocked extends Error {
  constructor(readonly decision: X402Decision) {
    super(`x402 payment blocked by INAM: ${decision.reason}`);
    this.name = "X402PaymentBlocked";
  }
}

interface PaymentRequired {
  accepts?: { payTo: string }[];
  extensions?: Record<string, { info?: { did?: unknown } }>;
}

const b64decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const b64encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Wraps `fetch` so x402 402 responses are checked before a payment wrapper
 * sees them. Compose it *inside* the payment wrapper:
 *
 *   const pay = wrapFetchWithPayment(withInamX402Gate(fetch, inam, policy), signer);
 *
 * Blocked payees throw `X402PaymentBlocked`, so nothing is signed. Allowed
 * ones are passed on with `accepts` narrowed to the bound `payTo`, so the
 * payment wrapper can't pick an unverified destination. */
// ponytail: x402 v2 header only; v1 (body JSON, X-PAYMENT) servers get treated as having no INAM ID.
export function withInamX402Gate(inner: typeof fetch, inam: InamClient, policy: X402Policy = {}): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (res.status !== 402) return res;
    // A 402 to a request that already carries a payment is the payee rejecting it; the payee was gated before
    // signing, so pass it through and let the payment wrapper report the real error.
    const sent = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (sent.has("payment-signature") || sent.has("x-payment")) return res;
    const header = res.headers.get("payment-required");
    let required: PaymentRequired;
    try {
      required = JSON.parse(b64decode(header ?? ""));
    } catch {
      throw new X402PaymentBlocked({ allow: false, reason: "no readable PAYMENT-REQUIRED header" });
    }
    const did = required.extensions?.[INAM_X402_EXTENSION]?.info?.did;
    if (typeof did !== "string") throw new X402PaymentBlocked({ allow: false, reason: "payee names no INAM ID" });

    let agent: AgentRecord, reputation: ReputationResult;
    try {
      [agent, reputation] = await Promise.all([inam.getAgent(did), inam.getReputation(did)]);
    } catch {
      throw new X402PaymentBlocked({ allow: false, did, reason: "payee INAM ID not found in the registry" });
    }
    const accepts = required.accepts ?? [];
    const decision = decideX402(agent, reputation, accepts.map((a) => a.payTo), policy);
    if (!decision.allow) throw new X402PaymentBlocked(decision);

    const bound = agent.linked.erc8004_id!.toLowerCase();
    const headers = new Headers(res.headers);
    headers.set("payment-required", b64encode(JSON.stringify({ ...required, accepts: accepts.filter((a) => a.payTo.toLowerCase() === bound) })));
    return new Response(res.body, { status: 402, statusText: res.statusText, headers });
  };
}
