-- SPEC v0.34: transparency-log entries commit to their payload by hash; the
-- payload itself lives in this nullable column so it can be withheld or erased.
-- Run once, before deploying the v0.34 Worker:
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-log-payload.sql
ALTER TABLE transparency_log ADD COLUMN payload TEXT;
