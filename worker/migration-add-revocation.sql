-- One-time migration for the *existing* production D1 database. The `agents`
-- table already exists there, so schema.sql's `CREATE TABLE IF NOT EXISTS`
-- is a no-op against it -- these ALTER TABLE statements are the only thing
-- that actually adds the columns. A fresh `db:init:local` / `db:init:remote`
-- against a brand-new database does NOT need this file.
--
-- MUST run before deploying any code (worker/src/agentService.ts's
-- revokeAgent, worker/src/signedRequest.ts's revoked-ID check,
-- worker/src/db.ts's rowToAgent) that reads or writes these columns --
-- rowToAgent reading a missing column throws.
--
-- Run once, manually, against the real production database:
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-revocation.sql
--
-- (For local dev: re-run `npm run db:init:local` against a fresh local D1 --
-- schema.sql already has the columns -- or run this file with --local.)

ALTER TABLE agents ADD COLUMN revoked_at TEXT;
ALTER TABLE agents ADD COLUMN revocation_reason TEXT;
