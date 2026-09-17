-- Adds an indexed junction table for agent capability search (audit #14,
-- Worker half). schema.sql's CREATE TABLE IF NOT EXISTS only helps a fresh
-- database -- the existing production `agents` table needs this table
-- created and backfilled before deploying code whose searchAgents no longer
-- does `SELECT * FROM agents` + an in-application filter.
CREATE TABLE IF NOT EXISTS agent_capabilities (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  capability TEXT NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_agent_capabilities_capability ON agent_capabilities(capability);

-- Backfill: one row per (agent, capability) from every existing agent's
-- `capabilities` JSON array, via SQLite's JSON1 json_each table function.
INSERT OR IGNORE INTO agent_capabilities (agent_id, capability)
SELECT agents.id, value
FROM agents, json_each(agents.capabilities);
