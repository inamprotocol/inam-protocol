import type { Context, Next } from "hono";
import type { AppEnv } from "./types.js";

/**
 * IP-scoped: registration mints a brand-new DID for free, so limiting by DID
 * would do nothing against a spammer generating fresh keypairs. Limiting by
 * source IP is the only lever available before an identity even exists.
 */
export async function rateLimitRegistrationByIp(c: Context<AppEnv>, next: Next) {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.RATE_LIMIT_REGISTER.limit({ key: `register:${ip}` });
  if (!success) {
    return c.json({ error: { code: "RATE_LIMITED", message: "Too many registration attempts from this address" } }, 429);
  }
  await next();
}

/**
 * DID-scoped: applied after requireSignedRequest, so `agentDid` is already
 * verified — caps a single agent's write volume regardless of source IP
 * (agents legitimately call from shared infrastructure/NAT).
 */
export async function rateLimitWriteByAgent(c: Context<AppEnv>, next: Next) {
  const agentDid = c.get("agentDid") ?? "anonymous";
  const { success } = await c.env.RATE_LIMIT_WRITE.limit({ key: `write:${agentDid}` });
  if (!success) {
    return c.json({ error: { code: "RATE_LIMITED", message: "Too many write requests from this agent" } }, 429);
  }
  await next();
}

/**
 * IP-scoped, applied to the public, unauthenticated reads that are actually
 * expensive to compute (reputation walks an agent's full receipt history;
 * search can compute reputation per candidate). Without this, anyone can
 * trigger repeated O(receipts) D1 reads for free — a cost-amplification
 * vector distinct from ordinary abuse, since no signature/identity is even
 * required to hit these routes.
 */
export async function rateLimitReadByIp(c: Context<AppEnv>, next: Next) {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.RATE_LIMIT_READ.limit({ key: `read:${ip}` });
  if (!success) {
    return c.json({ error: { code: "RATE_LIMITED", message: "Too many requests from this address" } }, 429);
  }
  await next();
}
