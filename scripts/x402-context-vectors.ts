import { writeFileSync } from "node:fs";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";
import { keypairFromPrivateKey } from "../sdk-js/src/crypto/keys.js";
import { counterpartyContext, x402PolicyInput, type X402Policy } from "../sdk-js/src/x402.js";
import type { AgentRecord, ReputationResult } from "../sdk-js/src/types.js";

// CounterpartyContext vectors for x402 #1777: each pins the exact policy input,
// its JCS form, and the hash, so another implementation can recompute both the
// hash and the decision. Regenerate: npx tsx scripts/x402-context-vectors.ts
export const VECTORS_PATH = "tests/vectors/x402-counterparty-context.json";

// Same fixed test key (all 0x01) as scripts/interop-vectors.ts; never use a fixed key for anything real.
const DID = keypairFromPrivateKey(new Uint8Array(32).fill(1)).did;
const BOUND = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const REQUEST = { resource: "https://paid.example/api/translate", amount: "1000", network: "eip155:8453", nonce: "req-0001" };

// EIP-55 test address from the EIP itself: stored lowercase, presented checksummed.
const MIXED = "0x52908400098527886E0F7030069857D2E4169EE7";

const agent = (o: { revokedAt?: string; bound?: string } = {}) =>
  ({ id: DID, linked: { erc8004_id: o.bound ?? BOUND }, revokedAt: o.revokedAt }) as unknown as AgentRecord;
const rep = (evidenceLevel: string, trustScore: number) =>
  ({ evidenceLevel, trustScore, flags: [], evidence: { freshness: { evaluatedAt: "2026-10-08T12:00:00.000Z" } } }) as unknown as ReputationResult;

const cases: { name: string; agent: AgentRecord; reputation: ReputationResult; payTo: string[]; policy?: X402Policy }[] = [
  { name: "allow: bound payTo, countersigned history", agent: agent(), reputation: rep("countersigned", 40), payTo: [BOUND] },
  { name: "deny: payTo not bound to the DID (borrowed DID)", agent: agent(), reputation: rep("countersigned", 40), payTo: [OTHER] },
  { name: "deny: newcomer with no countersigned work", agent: agent(), reputation: rep("none", 0), payTo: [BOUND] },
  { name: "deny: revoked DID", agent: agent({ revokedAt: "2026-10-01T00:00:00.000Z" }), reputation: rep("countersigned", 40), payTo: [BOUND] },
  { name: "deny: score below policy minimum", agent: agent(), reputation: rep("independently_verified", 30), payTo: [BOUND], policy: { minEvidence: "independently_verified", minTrustScore: 50 } },
  // Added after the recompute on #1777: pin reason precedence and address case.
  { name: "deny: two conditions fail (payTo unbound and newcomer), payTo reason wins", agent: agent(), reputation: rep("none", 0), payTo: [OTHER] },
  { name: "allow: checksummed mixed-case payTo matches a lowercase bound wallet", agent: agent({ bound: MIXED.toLowerCase() }), reputation: rep("countersigned", 40), payTo: [MIXED] },
];

export function buildVectors() {
  return {
    description: "INAM x402 gate CounterpartyContext vectors (x402-foundation/x402#1777). policy_input_hash = 'sha256:' + hex(sha256(UTF-8 of policy_input_canonical)); policy_input_canonical is the JCS (RFC 8785) form of policy_input. The decision is a function of policy_input alone: deny if revoked; deny unless bound_wallet is in pay_to; deny if evidence_level ranks below policy.minEvidence (none < countersigned < independently_verified) or trust_score < policy.minTrustScore; else allow. Conditions are checked in that order and the context's reason names the first one that fails. Addresses are compared case-insensitively: bound_wallet and pay_to are lowercased in policy_input.",
    policy_version: "inam-x402-gate/1",
    vectors: cases.map((c) => {
      const policy_input = x402PolicyInput(c.agent, c.reputation, c.payTo, REQUEST, c.policy);
      return { name: c.name, policy_input, policy_input_canonical: canonicalize(policy_input), context: counterpartyContext(c.agent, c.reputation, c.payTo, REQUEST, c.policy) };
    }),
  };
}

if (process.argv[1]?.endsWith("x402-context-vectors.ts")) writeFileSync(VECTORS_PATH, JSON.stringify(buildVectors(), null, 2) + "\n");
