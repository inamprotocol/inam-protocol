-- One-time migration for the existing production D1 database (SPEC.md v0.42,
-- §2.3 key succession). schema.sql already has these columns for a fresh
-- database; CREATE TABLE IF NOT EXISTS is a no-op against the live one.
--
-- MUST run before deploying the Worker code that reads/writes them
-- (db.ts's rowToAgent, succeedAgentIfActive, successionMap):
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-succession.sql

ALTER TABLE agents ADD COLUMN succeeded_by TEXT;
ALTER TABLE agents ADD COLUMN succeeded_at TEXT;
ALTER TABLE agents ADD COLUMN succession TEXT;
