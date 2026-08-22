import type { AgentRecord, Env, ExecutionReceipt } from "./types.js";

const UNIQUE_VIOLATION = "UNIQUE constraint failed";

export async function getAgent(env: Env, id: string): Promise<AgentRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first();
  return row ? rowToAgent(row) : null;
}

export class AgentAlreadyExistsError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent ${agentId} already exists`);
  }
}

/**
 * Plain INSERT — no ON CONFLICT. A racing duplicate registration hits SQLite's
 * UNIQUE constraint on `id` and throws, instead of two concurrent
 * check-then-insert calls both silently succeeding (the previous
 * upsert-based version's TOCTOU gap).
 */
export async function insertAgent(env: Env, agent: AgentRecord): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO agents (id, capabilities, metadata, linked, stake_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(agent.id, JSON.stringify(agent.capabilities), JSON.stringify(agent.metadata), JSON.stringify(agent.linked), agent.stakeUsd, agent.createdAt)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes(UNIQUE_VIOLATION)) {
      throw new AgentAlreadyExistsError(agent.id);
    }
    throw err;
  }
}

export async function updateAgentLinked(env: Env, id: string, linked: AgentRecord["linked"]): Promise<void> {
  await env.DB.prepare("UPDATE agents SET linked = ? WHERE id = ?").bind(JSON.stringify(linked), id).run();
}

export async function allAgents(env: Env): Promise<AgentRecord[]> {
  const { results } = await env.DB.prepare("SELECT * FROM agents").all();
  return results.map(rowToAgent);
}

export async function getReceipt(env: Env, receiptId: string): Promise<ExecutionReceipt | null> {
  const row = await env.DB.prepare("SELECT data FROM receipts WHERE receipt_id = ?").bind(receiptId).first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}

export class DuplicateReceiptError extends Error {
  constructor(public readonly receiptId: string) {
    super(`Receipt ${receiptId} already exists`);
  }
}

/**
 * Plain INSERT for a brand-new draft — a racing duplicate submission of
 * byte-identical content (same content-addressed receiptId) hits the
 * PRIMARY KEY constraint and throws, rather than a separate SELECT-then-INSERT
 * leaving a window for two drafts to both believe they're first.
 *
 * Batched with `PRAGMA foreign_keys = ON` because D1 does not guarantee that
 * pragma persists across the connection/session backing a given `env.DB`
 * call — batching guarantees both statements run in the same session.
 */
export async function insertDraftReceipt(env: Env, receipt: ExecutionReceipt): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare("PRAGMA foreign_keys = ON"),
      env.DB.prepare(
        `INSERT INTO receipts (receipt_id, agent_a_id, agent_b_id, status, completed_at, amount_usd, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(receipt.receiptId, receipt.agentA.id, receipt.agentB.id, receipt.status, receipt.result.completedAt, Number(receipt.settlement?.amount ?? 0), JSON.stringify(receipt)),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes(UNIQUE_VIOLATION)) {
      throw new DuplicateReceiptError(receipt.receiptId);
    }
    throw err;
  }
}

/**
 * Atomic compare-and-swap: only finalizes if the row is still `draft` at the
 * moment of the write. Returns false if another request already moved it
 * (finalized or otherwise) between this request's read and its write —
 * the caller should treat that as "no longer a draft", not silently succeed.
 */
export async function finalizeReceiptIfDraft(env: Env, receiptId: string, updated: ExecutionReceipt): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE receipts SET status = ?, data = ? WHERE receipt_id = ? AND status = 'draft'`,
  )
    .bind(updated.status, JSON.stringify(updated), receiptId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Same compare-and-swap pattern for opening a dispute against a finalized receipt. */
export async function disputeReceiptIfFinalized(env: Env, receiptId: string, updated: ExecutionReceipt): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE receipts SET status = ?, data = ? WHERE receipt_id = ? AND status = 'finalized'`,
  )
    .bind(updated.status, JSON.stringify(updated), receiptId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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
