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

-- Job (SPEC.md §3). Offers live in their own table rather than a JSON array
-- on `jobs` deliberately: two agents concurrently offering on the same job
-- are two independent INSERTs (no read-modify-write race on a shared blob),
-- and the PRIMARY KEY on (job_id, agent_id) makes a duplicate offer from the
-- same agent a clean UNIQUE-constraint rejection instead of requiring its
-- own application-level check-then-write.
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  posted_by TEXT NOT NULL REFERENCES agents(id),
  capability TEXT NOT NULL,
  spec_hash TEXT NOT NULL,
  budget_amount TEXT,
  budget_currency TEXT,
  status TEXT NOT NULL,           -- open | accepted | completed | cancelled
  accepted_agent_id TEXT,
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_capability_status ON jobs(capability, status);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_by ON jobs(posted_by);

CREATE TABLE IF NOT EXISTS job_offers (
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  agent_id TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, agent_id)
);
