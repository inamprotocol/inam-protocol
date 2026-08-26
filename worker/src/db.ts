import type { AgentRecord, Env, ExecutionReceipt, JobOffer, JobRecord, LinkChallengeRecord, VerificationRecord } from "./types.js";

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
      `INSERT INTO agents (id, capabilities, metadata, linked, stake_usd, created_at, is_authorized_verifier) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        agent.id,
        JSON.stringify(agent.capabilities),
        JSON.stringify(agent.metadata),
        JSON.stringify(agent.linked),
        agent.stakeUsd,
        agent.createdAt,
        agent.isAuthorizedVerifier ? 1 : 0,
      )
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

export async function updateAgentVerifierStatus(env: Env, id: string, authorized: boolean): Promise<void> {
  await env.DB.prepare("UPDATE agents SET is_authorized_verifier = ? WHERE id = ?").bind(authorized ? 1 : 0, id).run();
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

// ---- Jobs ----

export async function insertJob(env: Env, job: JobRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs (job_id, posted_by, capability, spec_hash, budget_amount, budget_currency, status, accepted_agent_id, receipt_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      job.jobId,
      job.postedBy,
      job.capability,
      job.specHash,
      job.budget?.amount ?? null,
      job.budget?.currency ?? null,
      job.status,
      job.acceptedAgentId ?? null,
      job.receiptId ?? null,
      job.createdAt,
      job.expiresAt ?? null,
    )
    .run();
}

export async function getJob(env: Env, jobId: string): Promise<JobRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE job_id = ?").bind(jobId).first();
  if (!row) return null;
  const offers = await getOffers(env, jobId);
  return rowToJob(row, offers);
}

export interface JobSearchQuery {
  capability?: string;
  status?: string;
}

export async function searchJobs(env: Env, query: JobSearchQuery): Promise<JobRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (query.capability) {
    conditions.push("capability = ?");
    params.push(query.capability);
  }
  if (query.status) {
    conditions.push("status = ?");
    params.push(query.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`SELECT * FROM jobs ${where}`).bind(...params).all();
  if (results.length === 0) return [];

  const jobIds = results.map((r) => r.job_id as string);
  const placeholders = jobIds.map(() => "?").join(",");
  const { results: offerRows } = await env.DB.prepare(`SELECT * FROM job_offers WHERE job_id IN (${placeholders})`)
    .bind(...jobIds)
    .all();
  const offersByJob = new Map<string, JobOffer[]>();
  for (const row of offerRows) {
    const jobId = row.job_id as string;
    const offer = rowToOffer(row);
    offersByJob.set(jobId, [...(offersByJob.get(jobId) ?? []), offer]);
  }
  return results.map((row) => rowToJob(row, offersByJob.get(row.job_id as string) ?? []));
}

export class OfferAlreadyExistsError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly agentId: string,
  ) {
    super(`Agent ${agentId} already has an offer on job ${jobId}`);
  }
}

/** Plain INSERT — the (job_id, agent_id) PRIMARY KEY rejects a duplicate offer
 * from the same agent as a UNIQUE violation, and two different agents
 * offering concurrently are simply two independent row inserts, never a
 * read-modify-write race on a shared list. */
export async function insertOffer(env: Env, jobId: string, offer: JobOffer): Promise<void> {
  try {
    await env.DB.prepare(`INSERT INTO job_offers (job_id, agent_id, message, created_at) VALUES (?, ?, ?, ?)`)
      .bind(jobId, offer.agentId, offer.message ?? null, offer.createdAt)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes(UNIQUE_VIOLATION)) {
      throw new OfferAlreadyExistsError(jobId, offer.agentId);
    }
    throw err;
  }
}

export async function getOffers(env: Env, jobId: string): Promise<JobOffer[]> {
  const { results } = await env.DB.prepare("SELECT * FROM job_offers WHERE job_id = ?").bind(jobId).all();
  return results.map(rowToOffer);
}

export async function offerExists(env: Env, jobId: string, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM job_offers WHERE job_id = ? AND agent_id = ?").bind(jobId, agentId).first();
  return row !== null;
}

/** Compare-and-swap: only accepts if the job is still `open`. */
export async function acceptJobIfOpen(env: Env, jobId: string, acceptedAgentId: string): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE jobs SET status = 'accepted', accepted_agent_id = ? WHERE job_id = ? AND status = 'open'`)
    .bind(acceptedAgentId, jobId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Compare-and-swap: only cancels a job that isn't already completed/cancelled. */
export async function cancelJobIfCancellable(env: Env, jobId: string): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE jobs SET status = 'cancelled' WHERE job_id = ? AND status NOT IN ('completed', 'cancelled')`)
    .bind(jobId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Best-effort: called after a receipt referencing this job is finalized.
 * A no-op (not an error) if the job doesn't exist or isn't `accepted` — the
 * receipt itself is already the source of truth by this point. */
export async function completeJobIfAccepted(env: Env, jobId: string, receiptId: string): Promise<void> {
  await env.DB.prepare(`UPDATE jobs SET status = 'completed', receipt_id = ? WHERE job_id = ? AND status = 'accepted'`)
    .bind(receiptId, jobId)
    .run();
}

// ---- Link challenges ----

export async function insertLinkChallenge(env: Env, record: LinkChallengeRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO link_challenges (challenge_id, agent_id, protocol, external_public_key, key_type, challenge, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
    .bind(record.challengeId, record.agentId, record.protocol, record.externalPublicKey, record.keyType, record.challenge, record.createdAt, record.expiresAt)
    .run();
}

export async function getLinkChallenge(env: Env, challengeId: string): Promise<LinkChallengeRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM link_challenges WHERE challenge_id = ?").bind(challengeId).first();
  return row ? rowToLinkChallenge(row) : null;
}

/** Compare-and-swap: only marks used if it's currently unused — the same
 * discipline as finalizeReceiptIfDraft/acceptJobIfOpen above, so a replayed
 * (challengeId, proof) pair can complete at most one link even under
 * concurrent requests. */
export async function consumeLinkChallengeIfUnused(env: Env, challengeId: string): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE link_challenges SET used = 1 WHERE challenge_id = ? AND used = 0`).bind(challengeId).run();
  return (result.meta.changes ?? 0) > 0;
}

function rowToLinkChallenge(row: Record<string, unknown>): LinkChallengeRecord {
  return {
    challengeId: row.challenge_id as string,
    agentId: row.agent_id as string,
    protocol: row.protocol as string,
    externalPublicKey: row.external_public_key as string,
    keyType: row.key_type as LinkChallengeRecord["keyType"],
    challenge: row.challenge as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    used: Boolean(row.used),
  };
}

// ---- Verifications ----

export class DuplicateVerificationError extends Error {
  constructor(public readonly verificationId: string) {
    super(`Verification ${verificationId} already exists`);
  }
}

/** Plain INSERT — a verification is created once and never transitions
 * state (unlike receipts/jobs), so a UNIQUE-violation catch on the
 * content-addressed verification_id is sufficient for DUPLICATE_VERIFICATION,
 * no compare-and-swap needed. */
export async function insertVerification(env: Env, record: VerificationRecord): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO verifications (verification_id, receipt_id, provider, verifier, result, data) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(record.verificationId, record.receiptId, record.provider, record.verifier, record.result, JSON.stringify(record))
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes(UNIQUE_VIOLATION)) {
      throw new DuplicateVerificationError(record.verificationId);
    }
    throw err;
  }
}

export async function getVerification(env: Env, id: string): Promise<VerificationRecord | null> {
  const row = await env.DB.prepare("SELECT data FROM verifications WHERE verification_id = ?").bind(id).first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}

export async function verificationsByReceipt(env: Env, receiptId: string): Promise<VerificationRecord[]> {
  const { results } = await env.DB.prepare("SELECT data FROM verifications WHERE receipt_id = ?").bind(receiptId).all<{ data: string }>();
  return results.map((r) => JSON.parse(r.data));
}

function rowToOffer(row: Record<string, unknown>): JobOffer {
  return {
    agentId: row.agent_id as string,
    message: (row.message as string | null) ?? undefined,
    createdAt: row.created_at as string,
  };
}

function rowToJob(row: Record<string, unknown>, offers: JobOffer[]): JobRecord {
  const budgetAmount = row.budget_amount as string | null;
  const budgetCurrency = row.budget_currency as string | null;
  return {
    jobId: row.job_id as string,
    postedBy: row.posted_by as string,
    capability: row.capability as string,
    specHash: row.spec_hash as string,
    budget: budgetAmount || budgetCurrency ? { amount: budgetAmount ?? undefined, currency: budgetCurrency ?? undefined } : undefined,
    status: row.status as JobRecord["status"],
    offers,
    acceptedAgentId: (row.accepted_agent_id as string | null) ?? undefined,
    receiptId: (row.receipt_id as string | null) ?? undefined,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? undefined,
  };
}

function rowToAgent(row: Record<string, unknown>): AgentRecord {
  return {
    id: row.id as string,
    capabilities: JSON.parse(row.capabilities as string),
    metadata: JSON.parse(row.metadata as string),
    linked: JSON.parse(row.linked as string),
    stakeUsd: row.stake_usd as number,
    createdAt: row.created_at as string,
    isAuthorizedVerifier: Boolean(row.is_authorized_verifier),
  };
}
