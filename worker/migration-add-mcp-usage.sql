-- One-time migration for the existing production D1 database: aggregate
-- hosted-MCP usage counter (worker/src/mcpUsage.ts). schema.sql already has
-- this table for a fresh database. Counts only: no IP, no arguments, no raw
-- User-Agent. The Worker swallows errors while the table is missing, so the
-- order of this migration and the deploy does not matter.
--   npx wrangler d1 execute inam-protocol-db --remote --file=./migration-add-mcp-usage.sql

CREATE TABLE IF NOT EXISTS mcp_usage (
  day TEXT NOT NULL,      -- UTC date, YYYY-MM-DD
  metric TEXT NOT NULL,   -- "connect" (tools/list) or "tool:<inam_* name>" (tools/call)
  client TEXT NOT NULL,   -- coarse family: claude-desktop, claude-remote, claude-code, claude-ai, other
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, client)
);
