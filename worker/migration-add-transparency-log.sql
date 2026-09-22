-- One-time migration for the *existing* production D1 database. The table
-- didn't exist before this feature, so schema.sql's `CREATE TABLE IF NOT
-- EXISTS` is enough for a fresh database, but the live database needs this
-- file run explicitly.
--
-- MUST run before deploying any code (worker/src/transparencyService.ts,
-- worker/src/receiptService.ts, worker/src/jobService.ts's calls into it)
-- that writes to this table -- an INSERT against a missing table throws.
--
-- Run once, manually, against the real production database:
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-transparency-log.sql
--
-- (For local dev: re-run `npm run db:init:local` against a fresh local D1 --
-- schema.sql already has this table -- or run this file with --local.)

CREATE TABLE IF NOT EXISTS transparency_log (
  leaf_index INTEGER PRIMARY KEY,
  entry_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  leaf_hash TEXT NOT NULL
);
