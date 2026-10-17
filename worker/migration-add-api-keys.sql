-- One-time migration for the existing production D1 database (SPEC.md v0.43,
-- §16 API keys + usage meter). schema.sql already has this table for a fresh
-- database. Only the SHA-256 of a key is stored, never the key.
--
-- MUST run before deploying the Worker code that reads/writes it (apiKeys.ts):
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-api-keys.sql

CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,   -- sha256 hex of the plaintext key
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  calls INTEGER NOT NULL DEFAULT 0 -- free-tier calls spent
);

CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id);
