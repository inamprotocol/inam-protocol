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
};
