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
  created_at TEXT NOT NULL,
  -- Verifier authorization (SPEC.md §12.3): only the registry's configured
  -- operator identity can flip this, via setVerifierStatus /
  -- POST /agents/:id/verifier-status -- never settable at registration.
  -- CREATE TABLE IF NOT EXISTS only helps a *fresh* database; the existing
  -- production `agents` table needs this column added separately (see the
  -- ALTER TABLE note in STATUS.md / the commit that introduced this field --
  -- do not deploy the code that reads/writes this column before that
  -- migration has actually been applied to the live D1 database).
  is_authorized_verifier INTEGER NOT NULL DEFAULT 0
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

-- External-identity link challenges (proof-of-possession before linking
-- agentpass_id / aitp_id / passport_id — SPEC.md's external-identity linking
-- section). Single-use: consuming one is `UPDATE ... WHERE used = 0` + a
-- meta.changes check, the same compare-and-swap discipline used for receipt
-- countersign/dispute and job accept/cancel above, rather than a
-- read-then-write that a concurrent replay could race.
CREATE TABLE IF NOT EXISTS link_challenges (
  challenge_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  protocol TEXT NOT NULL,
  external_public_key TEXT NOT NULL,  -- base64
  key_type TEXT NOT NULL,             -- ed25519 | p256
  challenge TEXT NOT NULL,            -- hex-encoded random bytes
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- Independent verification (SPEC.md §12): a single verifier's signed
-- attestation that a finalized receipt's output satisfies its job's
-- requirements. Created once, never transitions state, so a plain INSERT
-- (UNIQUE violation -> DUPLICATE_VERIFICATION) is sufficient here, unlike
-- receipts/jobs which need compare-and-swap UPDATEs.
CREATE TABLE IF NOT EXISTS verifications (
  verification_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  result TEXT NOT NULL,   -- verified | rejected
  data TEXT NOT NULL      -- full VerificationRecord JSON
);

CREATE INDEX IF NOT EXISTS idx_verifications_receipt ON verifications(receipt_id);
