-- INAM Protocol Registry — D1 schema (Cloudflare Workers deployment)
-- Mirrors the Node reference implementation's data model (src/types.ts) with
-- indexed columns for the two query patterns the API actually needs:
-- capability search and per-agent receipt history.

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  capabilities TEXT NOT NULL,   -- JSON array of strings
  metadata TEXT NOT NULL,       -- JSON object
  linked TEXT NOT NULL,         -- JSON object (LinkedIdentities)
  stake_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  agent_a_id TEXT NOT NULL REFERENCES agents(id),
  agent_b_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL,          -- draft | finalized | disputed
  completed_at TEXT NOT NULL,
  amount_usd REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL             -- full ExecutionReceipt JSON
);

CREATE INDEX IF NOT EXISTS idx_receipts_agent_a ON receipts(agent_a_id);
CREATE INDEX IF NOT EXISTS idx_receipts_agent_b ON receipts(agent_b_id);
