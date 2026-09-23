-- SPEC v0.31: draft receipts stored dispute.windowClosesAt as "" instead of
-- null. Rewrites the existing rows. Idempotent (only matches ""), and safe to
-- run before or after deploying Worker 0.7.1, since both versions treat the
-- field as "not set" when it's falsy.
--
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-draft-window-null.sql
UPDATE receipts
SET data = json_set(data, '$.dispute.windowClosesAt', json('null'))
WHERE json_extract(data, '$.dispute.windowClosesAt') = '';
