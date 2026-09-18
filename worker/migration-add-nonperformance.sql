-- One-time migration for the *existing* production D1 database. The `jobs`
-- table already exists there, so schema.sql's `CREATE TABLE IF NOT EXISTS`
-- is a no-op against it -- these ALTER TABLE statements are the only thing
-- that actually adds the columns and index.
--
-- MUST run before deploying any code (worker/src/jobService.ts's
-- reportNonPerformance/acceptOffer, worker/src/db.ts's rowToJob) that reads
-- or writes these columns -- rowToJob reading a missing column throws.
--
-- Run once, manually, against the real production database:
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-nonperformance.sql
--
-- (For local dev: re-run `npm run db:init:local` against a fresh local D1 --
-- schema.sql already has the columns/index -- or run this file with --local.)

ALTER TABLE jobs ADD COLUMN accepted_at TEXT;
ALTER TABLE jobs ADD COLUMN nonperformance_reported_at TEXT;
ALTER TABLE jobs ADD COLUMN nonperformance_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_status_accepted_agent ON jobs(status, accepted_agent_id);
