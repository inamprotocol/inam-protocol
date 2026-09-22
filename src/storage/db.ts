import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { config } from "../config.js";
import type { AgentRecord, ExecutionReceipt, JobRecord, LinkChallengeRecord, VerificationRecord } from "../types.js";

// process.getBuiltinModule (not a static `import "node:sqlite"`) sidesteps
// vite-node's builtin-module allowlist, which predates node:sqlite and
// otherwise tries to resolve it as a package during tests.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

mkdirSync(config.dataDir, { recursive: true });
const conn = new DatabaseSync(path.join(config.dataDir, "registry.db"));
conn.exec("PRAGMA journal_mode = WAL");
conn.exec("PRAGMA synchronous = NORMAL");

conn.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    revoked INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    PRIMARY KEY (agent_id, capability)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_capabilities_capability ON agent_capabilities (capability);

  CREATE TABLE IF NOT EXISTS receipts (
    receipt_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    agent_a_id TEXT NOT NULL,
    agent_b_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_agent_a ON receipts (agent_a_id);
  CREATE INDEX IF NOT EXISTS idx_receipts_agent_b ON receipts (agent_b_id);

  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    capability TEXT NOT NULL,
    status TEXT NOT NULL,
    posted_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_capability_status ON jobs (capability, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);

  CREATE TABLE IF NOT EXISTS verifications (
    verification_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    verifier TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_verifications_receipt_verifier ON verifications (receipt_id, verifier);

  CREATE TABLE IF NOT EXISTS transparency_log (
    leaf_index INTEGER PRIMARY KEY,
    entry_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL,
    leaf_hash TEXT NOT NULL
  );
`);

/** A blob-plus-indexed-columns table: `data` is the JSON source of truth,
 *  the extra columns exist only so SQLite can index the fields services
 *  actually filter/join on. Callers get back the same T they put in. */
class Repo<T> {
  constructor(
    private readonly table: string,
    private readonly idColumn: string,
  ) {}

  get(id: string): T | undefined {
    const row = conn.prepare(`SELECT data FROM ${this.table} WHERE ${this.idColumn} = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  has(id: string): boolean {
    return conn.prepare(`SELECT 1 FROM ${this.table} WHERE ${this.idColumn} = ?`).get(id) !== undefined;
  }

  protected rowsToRecords(rows: Array<{ data: string }>): T[] {
    return rows.map((r) => JSON.parse(r.data) as T);
  }
}

class AgentsRepo extends Repo<AgentRecord> {
  constructor() {
    super("agents", "id");
  }

  set(id: string, value: AgentRecord): void {
    conn.exec("BEGIN");
    try {
      conn
        .prepare("INSERT INTO agents (id, data, revoked) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, revoked = excluded.revoked")
        .run(id, JSON.stringify(value), value.revokedAt ? 1 : 0);
      conn.prepare("DELETE FROM agent_capabilities WHERE agent_id = ?").run(id);
      const insertCap = conn.prepare("INSERT INTO agent_capabilities (agent_id, capability) VALUES (?, ?)");
      for (const capability of value.capabilities) insertCap.run(id, capability);
      conn.exec("COMMIT");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  /** `supports` (does `linked` contain this protocol key) has no dedicated
   *  index — it's rare and always AND'd with a capability/revoked filter
   *  that's already cheap, so a JS post-filter over the pre-filtered rows
   *  is simplest. ponytail: revisit if `supports` searches grow common. */
  search(query: { capability?: string; supports?: string; includeRevoked?: boolean }): AgentRecord[] {
    let rows: Array<{ data: string }>;
    if (query.capability) {
      rows = conn
        .prepare(
          `SELECT a.data FROM agents a JOIN agent_capabilities c ON c.agent_id = a.id
           WHERE c.capability = ? ${query.includeRevoked ? "" : "AND a.revoked = 0"}`,
        )
        .all(query.capability) as Array<{ data: string }>;
    } else {
      rows = conn.prepare(`SELECT data FROM agents ${query.includeRevoked ? "" : "WHERE revoked = 0"}`).all() as Array<{ data: string }>;
    }
    const records = this.rowsToRecords(rows);
    return query.supports ? records.filter((a) => query.supports! in a.linked) : records;
  }
}

class ReceiptsRepo extends Repo<ExecutionReceipt> {
  constructor() {
    super("receipts", "receipt_id");
  }

  set(id: string, value: ExecutionReceipt): void {
    conn
      .prepare(
        "INSERT INTO receipts (receipt_id, data, agent_a_id, agent_b_id) VALUES (?, ?, ?, ?) ON CONFLICT(receipt_id) DO UPDATE SET data = excluded.data",
      )
      .run(id, JSON.stringify(value), value.agentA.id, value.agentB.id);
  }

  listByAgent(agentId: string): ExecutionReceipt[] {
    const rows = conn.prepare("SELECT data FROM receipts WHERE agent_a_id = ? OR agent_b_id = ?").all(agentId, agentId) as Array<{ data: string }>;
    return this.rowsToRecords(rows);
  }
}

class JobsRepo extends Repo<JobRecord> {
  constructor() {
    super("jobs", "job_id");
  }

  set(id: string, value: JobRecord): void {
    conn
      .prepare(
        "INSERT INTO jobs (job_id, data, capability, status, posted_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET data = excluded.data, capability = excluded.capability, status = excluded.status",
      )
      .run(id, JSON.stringify(value), value.capability, value.status, value.postedBy);
  }

  search(query: { capability?: string; status?: string }): JobRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.capability) {
      clauses.push("capability = ?");
      params.push(query.capability);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = conn.prepare(`SELECT data FROM jobs ${where}`).all(...params) as Array<{ data: string }>;
    return this.rowsToRecords(rows);
  }
}

class VerificationsRepo extends Repo<VerificationRecord> {
  constructor() {
    super("verifications", "verification_id");
  }

  set(id: string, value: VerificationRecord): void {
    conn
      .prepare(
        "INSERT INTO verifications (verification_id, data, receipt_id, verifier) VALUES (?, ?, ?, ?) ON CONFLICT(verification_id) DO UPDATE SET data = excluded.data",
      )
      .run(id, JSON.stringify(value), value.receiptId, value.verifier);
  }

  listByReceipt(receiptId: string): VerificationRecord[] {
    const rows = conn.prepare("SELECT data FROM verifications WHERE receipt_id = ?").all(receiptId) as Array<{ data: string }>;
    return this.rowsToRecords(rows);
  }

  hasDecisionBy(receiptId: string, verifier: string): boolean {
    return conn.prepare("SELECT 1 FROM verifications WHERE receipt_id = ? AND verifier = ?").get(receiptId, verifier) !== undefined;
  }
}

/** Test-only: confirms a query hits an index rather than scanning the table.
 *  Not used by any service. */
export function explainQueryPlan(sql: string): string {
  return (conn.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join("; ");
}

export interface TransparencyLogEntry {
  leafIndex: number;
  entryType: string;
  refId: string;
  createdAt: string;
  data: string;
  leafHash: string;
}

/** Append-only by construction: no `set`/update method exists, only
 *  `append` (INSERT, never UPDATE) and reads. `leaf_index` is assigned as
 *  the current row count inside the same transaction as the insert, so it's
 *  always the next contiguous 0-based index — single-process reference
 *  implementation, no concurrent-writer race to guard against here. */
class TransparencyLogRepo {
  append(entryType: string, refId: string, createdAt: string, data: string, leafHash: string): number {
    conn.exec("BEGIN");
    try {
      const { n } = conn.prepare("SELECT COUNT(*) AS n FROM transparency_log").get() as { n: number };
      conn
        .prepare("INSERT INTO transparency_log (leaf_index, entry_type, ref_id, created_at, data, leaf_hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(n, entryType, refId, createdAt, data, leafHash);
      conn.exec("COMMIT");
      return n;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  count(): number {
    return (conn.prepare("SELECT COUNT(*) AS n FROM transparency_log").get() as { n: number }).n;
  }

  /** Ordered leaf hashes from index 0, the only shape merkleLog.ts's pure
   *  functions need. `upTo` bounds it to a past tree size a caller observed. */
  leafHashes(upTo?: number): string[] {
    const sql = upTo === undefined ? "SELECT leaf_hash FROM transparency_log ORDER BY leaf_index ASC" : "SELECT leaf_hash FROM transparency_log WHERE leaf_index < ? ORDER BY leaf_index ASC";
    const rows = (upTo === undefined ? conn.prepare(sql).all() : conn.prepare(sql).all(upTo)) as Array<{ leaf_hash: string }>;
    return rows.map((r) => r.leaf_hash);
  }

  entries(limit: number, offset: number): TransparencyLogEntry[] {
    const rows = conn
      .prepare("SELECT leaf_index, entry_type, ref_id, created_at, data, leaf_hash FROM transparency_log ORDER BY leaf_index ASC LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<{ leaf_index: number; entry_type: string; ref_id: string; created_at: string; data: string; leaf_hash: string }>;
    return rows.map((r) => ({ leafIndex: r.leaf_index, entryType: r.entry_type, refId: r.ref_id, createdAt: r.created_at, data: r.data, leafHash: r.leaf_hash }));
  }
}

export const agents = new AgentsRepo();
export const receipts = new ReceiptsRepo();
export const jobs = new JobsRepo();
export const verifications = new VerificationsRepo();
export const transparencyLog = new TransparencyLogRepo();

/** In-memory idempotency cache: (agentDid:key) -> cached response + expiry.
 *  Only terminal 2xx responses are stored (see middleware/idempotency.ts) so
 *  a transient error stays retryable. Resets on restart — a real deployment
 *  backs this with a shared TTL store (SPEC.md §7). */
export const idempotencyCache = new Map<string, { status: number; body: unknown; expiresAt: number }>();

/** In-memory signature-replay guard: sha256(inam-signature) -> the single
 *  Idempotency-Key that signature was first seen with, plus expiry (the
 *  request-signing clock-skew window — after it the signature is refused as
 *  STALE anyway). Presenting one signature with a *different* key means a
 *  captured request is being replayed to force a second side effect; the
 *  signing string doesn't cover the key, so the signature alone still
 *  verifies (SPEC.md §7). Resets on restart. */
export const signatureReplayCache = new Map<string, { idempotencyKey: string; expiresAt: number }>();

function pruneExpired<T extends { expiresAt: number }>(map: Map<string, T>): void {
  const now = Date.now();
  for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
}

/** Read from a TTL'd in-memory cache, evicting the entry if it has expired. */
export function readFresh<T extends { expiresAt: number }>(map: Map<string, T>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit;
}

/** Write to a TTL'd in-memory cache, sweeping expired entries first once the
 *  map grows past a threshold — so keys that are written once and never
 *  re-read (attack traffic, unique idempotency keys) can't grow it without
 *  bound. ponytail: O(n) sweep past 5k live entries; a real deployment uses a
 *  shared TTL store (Redis/KV) with native expiry instead. */
export function setWithSweep<T extends { expiresAt: number }>(map: Map<string, T>, key: string, value: T): void {
  if (map.size > 5000) pruneExpired(map);
  map.set(key, value);
}

/** In-memory, short-lived (60s) link challenges — not persisted to disk on
 * purpose, same reasoning as the idempotency cache above. */
export const linkChallenges = new Map<string, LinkChallengeRecord>();
