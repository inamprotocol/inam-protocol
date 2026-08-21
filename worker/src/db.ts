import type { AgentRecord, Env, ExecutionReceipt } from "./types.js";

export async function getAgent(env: Env, id: string): Promise<AgentRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first();
  return row ? rowToAgent(row) : null;
}

export async function putAgent(env: Env, agent: AgentRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agents (id, capabilities, metadata, linked, stake_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET capabilities = excluded.capabilities, metadata = excluded.metadata,
       linked = excluded.linked, stake_usd = excluded.stake_usd`,
  )
    .bind(
      agent.id,
      JSON.stringify(agent.capabilities),
      JSON.stringify(agent.metadata),
      JSON.stringify(agent.linked),
      agent.stakeUsd,
      agent.createdAt,
    )
    .run();
}

export async function allAgents(env: Env): Promise<AgentRecord[]> {
  const { results } = await env.DB.prepare("SELECT * FROM agents").all();
  return results.map(rowToAgent);
}

export async function getReceipt(env: Env, receiptId: string): Promise<ExecutionReceipt | null> {
  const row = await env.DB.prepare("SELECT data FROM receipts WHERE receipt_id = ?").bind(receiptId).first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}

export async function putReceipt(env: Env, receipt: ExecutionReceipt): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO receipts (receipt_id, agent_a_id, agent_b_id, status, completed_at, amount_usd, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(receipt_id) DO UPDATE SET status = excluded.status, data = excluded.data`,
  )
    .bind(
      receipt.receiptId,
      receipt.agentA.id,
      receipt.agentB.id,
      receipt.status,
      receipt.result.completedAt,
      Number(receipt.settlement?.amount ?? 0),
      JSON.stringify(receipt),
    )
    .run();
}

export async function receiptsByAgent(env: Env, agentId: string): Promise<ExecutionReceipt[]> {
  const { results } = await env.DB.prepare("SELECT data FROM receipts WHERE agent_a_id = ? OR agent_b_id = ?")
    .bind(agentId, agentId)
    .all<{ data: string }>();
  return results.map((r) => JSON.parse(r.data));
}

function rowToAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: row.id as string,
    capabilities: JSON.parse(row.capabilities as string),
    metadata: JSON.parse(row.metadata as string),
    linked: JSON.parse(row.linked as string),
    stakeUsd: row.stake_usd as number,
    createdAt: row.created_at as string,
  };
}
