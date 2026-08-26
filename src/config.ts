import path from "node:path";

export const config = {
  port: Number(process.env.PORT ?? 4021),
  dataDir: process.env.INAM_DATA_DIR ? path.resolve(process.env.INAM_DATA_DIR) : path.resolve(process.cwd(), "data"),
  // Reputation engine tuning — see reputationService.ts for how these are used.
  decayHalfLifeDays: 90,
  disputeWindowHours: 72,
  // Signed-request auth: how much clock skew we tolerate between client and server.
  clockSkewMs: 5 * 60 * 1000,
  // Collusion heuristic: if one counterparty accounts for more than this share
  // of an agent's finalized receipts, flag it for review instead of silently
  // trusting the volume. Seed of the fuller clustering-based detection.
  concentratedCounterpartyThreshold: 0.6,
  // External-identity link challenges (ATTP §4: "expiration window not
  // exceeding 60 seconds").
  linkChallengeTtlMs: 60 * 1000,
  // The one identity allowed to grant/revoke an agent's verifier status
  // (SPEC.md §12.3 — "verifier must be operator-authorized", not "any
  // registered agent"). Unset by default: no requests can be authorized as
  // operator until this is deliberately configured, which is the safe
  // default (locked down) rather than the permissive one. Set via
  // INAM_OPERATOR_DID for a real deployment; this is a public identifier
  // (a did:key), not a secret -- the corresponding private key is what the
  // operator keeps safe.
  operatorDid: process.env.INAM_OPERATOR_DID,
};
