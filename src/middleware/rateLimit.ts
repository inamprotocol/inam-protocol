import type { NextFunction, Request, Response } from "express";
import { tooManyRequests } from "./errors.js";

/**
 * In-memory fixed-window limiter — fine for a single-process reference
 * server; the Cloudflare deployment uses the platform's native Rate Limiting
 * binding instead (worker/src/rateLimit.ts), since a per-process in-memory
 * counter wouldn't mean anything across many concurrent Worker isolates.
 */
function createFixedWindowLimiter(limit: number, windowMs: number) {
  const counters = new Map<string, { count: number; windowStart: number }>();

  return function checkLimit(key: string): boolean {
    const now = Date.now();
    const entry = counters.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      counters.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  };
}

// Matches the policy documented in worker/src/rateLimit.ts: registration is
// IP-scoped (a DID is free to mint, so limiting by DID would do nothing
// against a spammer generating fresh keypairs); other writes are DID-scoped.
const checkRegistrationLimit = createFixedWindowLimiter(10, 60_000);
const checkWriteLimit = createFixedWindowLimiter(60, 60_000);

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function rateLimitRegistrationByIp(req: Request, _res: Response, next: NextFunction) {
  if (!checkRegistrationLimit(clientIp(req))) {
    throw tooManyRequests("RATE_LIMITED", "Too many registration attempts from this address");
  }
  next();
}

export function rateLimitWriteByAgent(req: Request, _res: Response, next: NextFunction) {
  const agentDid = req.agentDid ?? "anonymous";
  if (!checkWriteLimit(agentDid)) {
    throw tooManyRequests("RATE_LIMITED", "Too many write requests from this agent");
  }
  next();
}

// Matches worker/src/rateLimit.ts's rateLimitReadByIp: reputation/search are
// the two reads expensive enough (O(receipts) per call) to be worth
// protecting even though they're intentionally public/unauthenticated.
const checkReadLimit = createFixedWindowLimiter(120, 60_000);

export function rateLimitReadByIp(req: Request, _res: Response, next: NextFunction) {
  if (!checkReadLimit(clientIp(req))) {
    throw tooManyRequests("RATE_LIMITED", "Too many requests from this address");
  }
  next();
}
