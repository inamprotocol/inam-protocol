import type { Context, Next } from "hono";
import { badRequest } from "./errors.js";
import type { AppEnv } from "./types.js";

const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;

/**
 * KV-backed idempotency cache (unlike the Node reference's in-memory Map,
 * this survives across requests/isolates, which is the whole point on a
 * multi-instance edge deployment). KV's eventual consistency is an
 * acceptable trade-off here: idempotency is a convenience against retried
 * requests, not the source of correctness for the receipt signatures
 * themselves.
 */
export async function requireIdempotencyKey(c: Context<AppEnv>, next: Next) {
  const key = c.req.header("idempotency-key");
  if (!key) {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required for this operation");
  }
  const agentDid = c.get("agentDid") ?? "anonymous";
  const cacheKey = `idem:${agentDid}:${key}`;

  const cached = await c.env.IDEMPOTENCY.get(cacheKey, "json");
  if (cached) {
    const { status, body } = cached as { status: number; body: unknown };
    return c.json(body, status as never);
  }

  await next();

  const status = c.res.status;
  const body = await c.res.clone().json().catch(() => null);
  if (body !== null) {
    await c.env.IDEMPOTENCY.put(cacheKey, JSON.stringify({ status, body }), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
  }
}
