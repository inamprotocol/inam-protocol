-- SPEC v0.33: tag agents registered before the `metadata.demo` /
-- `metadata.reference` convention existed. Data-only, no schema change.
-- Idempotent (json_set overwrites with the same value), and safe before or
-- after deploying Worker 0.9.0 — older code simply ignores the new keys.
--
--   npx wrangler d1 execute inam-protocol-db --remote --file backfill-demo-reference-tags.sql

UPDATE agents SET metadata = json_set(metadata, '$.demo', json('true'))
WHERE json_extract(metadata, '$.name') LIKE 'Quickstart demo%'
   OR json_extract(metadata, '$.name') LIKE 'Skill demo%';

UPDATE agents SET metadata = json_set(metadata, '$.reference', json('true'))
WHERE json_extract(metadata, '$.name') LIKE 'Reference %'
  AND json_extract(metadata, '$.description') LIKE '%Seeded by the protocol maintainer%';
