import type { Context, Next } from "hono";
import { sha256Hex } from "../../sdk-js/src/crypto/keys.js";
import { badRequest, conflict } from "./errors.js";
import type { AppEnv } from "./types.js";

const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
// = the signed-request clock-skew window (worker/src/signedRequest.ts). After
// this a captured signature is refused as STALE anyway, so it can't be
// replayed past it.
const REPLAY_GUARD_TTL_SECONDS = 5 * 60;

/**
 * KV-backed idempotency cache + signature-replay guard (unlike the Node
 * reference's in-memory Maps, this survives across requests/isolates, which
 * is the point on a multi-instance edge deployment). KV's eventual
 * consistency is an acceptable trade-off: for the idempotency cache it only
 * risks re-running an operation whose own guards (content-addressing, state
 * machine) already make a repeat safe; for the replay guard a request racing
 * the original within ~60s at a different edge location could slip through,
 * with those same operation guards as the backstop. A registry needing a
 * hard guarantee should back this with a Durable Object or D1.
 */
export async function requireIdempotencyKey(c: Context<AppEnv>, next: Next) {
  const key = c.req.header("idempotency-key");
  if (!key || key.trim() === "") {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required for this operation");
  }
  const agentDid = c.get("agentDid") ?? "anonymous";
  const cacheKey = `idem:${agentDid}:${key}`;

  const cached = await c.env.IDEMPOTENCY.get(cacheKey, "json");
  if (cached) {
    const { status, body } = cached as { status: number; body: unknown };
    return c.json(body, status as never);
  }

  // Replay guard — see src/middleware/idempotency.ts for the rationale. A
  // given verified signature may only ever pair with one Idempotency-Key.
  const sigKey = `replay:${agentDid}:${sha256Hex(c.req.header("inam-signature") ?? "")}`;
  const seenKey = await c.env.IDEMPOTENCY.get(sigKey);
  if (seenKey !== null && seenKey !== key) {
    throw conflict(
      "REPLAYED_REQUEST",
      "This request signature was already used with a different Idempotency-Key — regenerate the request with a fresh timestamp",
    );
  }
  if (seenKey === null) {
    await c.env.IDEMPOTENCY.put(sigKey, key, { expirationTtl: REPLAY_GUARD_TTL_SECONDS });
  }

  await next();

  // Only cache a terminal success — a transient 5xx/429 must stay retryable
  // with the same key.
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    const body = await c.res.clone().json().catch(() => null);
    if (body !== null) {
      await c.env.IDEMPOTENCY.put(cacheKey, JSON.stringify({ status, body }), { expirationTtl: IDEMPOTENCY_TTL_SECONDS });
    }
  }
}
