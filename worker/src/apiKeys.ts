import { sha256Hex, toHex } from "../../sdk-js/src/crypto/keys.js";
import { conflict, notFound } from "./errors.js";
import { getAgent } from "./agentService.js";
import type { Env } from "./types.js";

/** Price of one paid check call in USDC. The ONE place it is set: the x402
 * offer (check.ts) and the key usage reports both derive from it. To move to
 * 0.005, change this line. */
export const CHECK_PRICE_USDC = "0.001";
/** Same price in USDC base units (6 decimals), derived. */
export const CHECK_PRICE_UNITS = String(Math.round(Number(CHECK_PRICE_USDC) * 1e6));

/** Calls per key served without payment (lifetime of the key, no reset). */
export const FREE_TIER_CALLS = 100;
/** Active keys one agent may hold at once. */
export const MAX_ACTIVE_KEYS_PER_AGENT = 5;

const KEY_PREFIX = "inam_k_";

export interface ApiKeyUsage {
  keyId: string;
  agentId: string;
  createdAt: string;
  revokedAt: string | null;
  calls: number;
  freeTierCalls: number;
  freeTierRemaining: number;
  pricePerCallUsdc: string;
}

interface Row {
  key_id: string;
  agent_id: string;
  created_at: string;
  revoked_at: string | null;
  calls: number;
}

const usage = (r: Row): ApiKeyUsage => ({
  keyId: r.key_id,
  agentId: r.agent_id,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  calls: r.calls,
  freeTierCalls: FREE_TIER_CALLS,
  freeTierRemaining: Math.max(0, FREE_TIER_CALLS - r.calls),
  pricePerCallUsdc: CHECK_PRICE_USDC,
});

// 256-bit random secret, so an unsalted SHA-256 is enough: there is nothing to brute-force.
const hashKey = (key: string) => sha256Hex(key);

/** Mints a key for a registered agent. The plaintext is returned once and never stored. */
export async function issueKey(env: Env, agentId: string): Promise<ApiKeyUsage & { apiKey: string }> {
  await getAgent(env, agentId); // AGENT_NOT_FOUND for a DID that never registered
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const apiKey = KEY_PREFIX + toHex(secret);
  const keyId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // Cap enforced inside the INSERT so concurrent issues cannot overshoot it.
  const res = await env.DB.prepare(
    "INSERT INTO api_keys (key_id, key_hash, agent_id, created_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM api_keys WHERE agent_id = ? AND revoked_at IS NULL) < ?",
  )
    .bind(keyId, hashKey(apiKey), agentId, createdAt, agentId, MAX_ACTIVE_KEYS_PER_AGENT)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict("API_KEY_LIMIT", `An agent may hold at most ${MAX_ACTIVE_KEYS_PER_AGENT} active API keys; revoke one first`);
  }
  return { apiKey, ...usage({ key_id: keyId, agent_id: agentId, created_at: createdAt, revoked_at: null, calls: 0 }) };
}

export async function listKeys(env: Env, agentId: string): Promise<ApiKeyUsage[]> {
  const { results } = await env.DB.prepare("SELECT key_id, agent_id, created_at, revoked_at, calls FROM api_keys WHERE agent_id = ? ORDER BY created_at")
    .bind(agentId)
    .all<Row>();
  return results.map(usage);
}

/** Owner-only; compare-and-swap on revoked_at so a second revoke is a clean 404. */
export async function revokeKey(env: Env, agentId: string, keyId: string): Promise<ApiKeyUsage> {
  const res = await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND agent_id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), keyId, agentId)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw notFound("API_KEY_NOT_FOUND", `No active API key ${keyId} for this agent`);
  return (await listKeys(env, agentId)).find((k) => k.keyId === keyId)!;
}

export type MeterResult = "granted" | "exhausted" | "invalid";

/** Spends one free-tier call. One conditional UPDATE: the counter can never pass the limit under concurrency. */
export async function meterKey(env: Env, apiKey: string): Promise<MeterResult> {
  const hash = hashKey(apiKey);
  const res = await env.DB.prepare("UPDATE api_keys SET calls = calls + 1 WHERE key_hash = ? AND revoked_at IS NULL AND calls < ?").bind(hash, FREE_TIER_CALLS).run();
  if ((res.meta.changes ?? 0) > 0) return "granted";
  const row = await env.DB.prepare("SELECT 1 AS ok FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").bind(hash).first();
  return row ? "exhausted" : "invalid";
}

/** Gives back a call that produced no answer (a 4xx for a bad target). */
export async function refundKey(env: Env, apiKey: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET calls = calls - 1 WHERE key_hash = ? AND calls > 0").bind(hashKey(apiKey)).run();
}
