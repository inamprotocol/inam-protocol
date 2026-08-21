import type { NextFunction, Request, Response } from "express";
import { idempotencyCache } from "../storage/db.js";
import { badRequest } from "./errors.js";

/**
 * Requires an Idempotency-Key header on mutating requests and replays the
 * cached response for a repeated (agentDid, key) pair instead of re-running
 * the handler. In-memory only for this reference implementation — a real
 * deployment would back this with a TTL'd store shared across instances.
 */
export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("idempotency-key");
  if (!key) {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required for this operation");
  }
  const cacheKey = `${req.agentDid ?? "anonymous"}:${key}`;
  const cached = idempotencyCache.get(cacheKey);
  if (cached) {
    res.status(cached.status).json(cached.body);
    return;
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    idempotencyCache.set(cacheKey, { status: res.statusCode, body });
    return originalJson(body);
  };
  next();
}
