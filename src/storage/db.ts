import path from "node:path";
import { JsonStore } from "./jsonStore.js";
import { config } from "../config.js";
import type { AgentRecord, ExecutionReceipt, JobRecord, LinkChallengeRecord, VerificationRecord } from "../types.js";

export const agents = new JsonStore<AgentRecord>(path.join(config.dataDir, "agents.json"));
export const receipts = new JsonStore<ExecutionReceipt>(path.join(config.dataDir, "receipts.json"));
export const jobs = new JsonStore<JobRecord>(path.join(config.dataDir, "jobs.json"));
export const verifications = new JsonStore<VerificationRecord>(path.join(config.dataDir, "verifications.json"));

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
