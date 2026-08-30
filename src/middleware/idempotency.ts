import type { NextFunction, Request, Response } from "express";
import { idempotencyCache, signatureReplayCache, readFresh, setWithSweep } from "../storage/db.js";
import { config } from "../config.js";
import { sha256Hex } from "../../sdk-js/src/crypto/keys.js";
import { badRequest, conflict } from "./errors.js";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Requires an Idempotency-Key header on mutating requests, replays the cached
 * response for a repeated (agentDid, key) pair, and guards against replay of a
 * captured request. In-memory only for this reference implementation — a real
 * deployment would back both caches with a TTL'd store shared across
 * instances (SPEC.md §7).
 */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("idempotency-key");
  if (!key || key.trim() === "") {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required for this operation");
  }
  const cacheKey = `${req.agentDid ?? "anonymous"}:${key}`;

  const cached = readFresh(idempotencyCache, cacheKey);
  if (cached) {
    res.status(cached.status).json(cached.body);
    return;
  }

  // Replay guard: requireSignedRequest ran first, so inam-signature is
  // present and already verified. A given signature may only ever pair with
  // one Idempotency-Key — the same signature presented with a different key
  // is a captured request being replayed to force a second side effect (the
  // signing string doesn't cover the key, so the signature alone still
  // verifies). Bounded by the same clock-skew window that bounds how long a
  // signature is accepted at all.
  const sigKey = sha256Hex(req.header("inam-signature") ?? "");
  const seen = readFresh(signatureReplayCache, sigKey);
  if (seen) {
    if (seen.idempotencyKey !== key) {
      throw conflict(
        "REPLAYED_REQUEST",
        "This request signature was already used with a different Idempotency-Key — regenerate the request with a fresh timestamp",
      );
    }
    // Same key, no cached response (previous attempt errored or was evicted):
    // fall through and let the operation's own guards run again.
  } else {
    setWithSweep(signatureReplayCache, sigKey, { idempotencyKey: key, expiresAt: Date.now() + config.clockSkewMs });
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    // Only cache a terminal success. Caching a transient 5xx (or a 429) would
    // pin that failure for the whole TTL, so a legitimate retry with the same
    // key could never get through.
    if (res.statusCode >= 200 && res.statusCode < 300) {
      setWithSweep(idempotencyCache, cacheKey, { status: res.statusCode, body, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
    }
    return originalJson(body);
  };
  next();
}
