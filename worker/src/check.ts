import type { Context, Hono } from "hono";
import type { AppEnv } from "./types.js";
import { checkTarget, nextStep } from "../../sdk-js/src/check.js";
import { fromHex } from "../../sdk-js/src/crypto/keys.js";
import { webBotAuthHeaders } from "../../sdk-js/src/webBotAuth.js";

/**
 * Hosted pre-payment check: GET /v1/check?target=<url | 0x wallet | did:key>[&method=POST][&rdap=0].
 *
 * Runs the same engine as `npx inamprotocol check --json` (sdk-js/src/check.ts) and adds
 * `next` (one short step for the caller) and `cachedAt`. Results are kept in the Cache API
 * for TTL seconds: the ERC-8004 indexer allows 30 req/min per IP and every caller shares
 * this Worker's egress. Registry lookups run in-process (app.request, caller's IP forwarded);
 * every other outbound request is signed with Web Bot Auth when WEB_BOT_AUTH_KEY is set.
 */
const TTL = 600;
const USAGE = "Expected target=<x402 endpoint http(s) URL | 0x EVM wallet (40 hex) | did:key:z...>; optional method=POST for endpoints that only answer POST, rdap=0 to skip the domain-age lookup.";
const bad = (c: Context<AppEnv>, message: string) => c.json({ error: { code: "VALIDATION_ERROR", message } }, 400);

export function checkHandler(app: Hono<AppEnv>) {
  return async (c: Context<AppEnv>) => {
    const target = c.req.query("target")?.trim();
    const method = (c.req.query("method") ?? "GET").toUpperCase();
    const noRdap = c.req.query("rdap") === "0";
    if (!target) return bad(c, `target is required. ${USAGE}`);
    if (!["GET", "POST", "HEAD"].includes(method)) return bad(c, `method must be GET, POST or HEAD. ${USAGE}`);
    const self = new URL(c.req.url);
    if (target.startsWith(`${self.origin}/v1/check`)) return bad(c, "target cannot be this check endpoint");

    // Keyed under our own origin: the Cache API only stores keys in the zone the Worker runs on.
    const key = new Request(`${self.origin}/__check-cache?${new URLSearchParams({ target, method, rdap: noRdap ? "0" : "1" })}`);
    const hit = await caches.default.match(key);
    if (hit) return c.json(await hit.json(), 200, { "cache-control": `public, max-age=${TTL}` });

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const signer = c.env.WEB_BOT_AUTH_KEY ? fromHex(c.env.WEB_BOT_AUTH_KEY) : null;
    const f = (async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const headers = init.headers as Record<string, string> | undefined;
      if (url.startsWith(`${self.origin}/v1/agents`))
        return app.request(url.slice(self.origin.length), { ...init, headers: { ...headers, "cf-connecting-ip": ip } }, c.env, c.executionCtx);
      const signed = signer ? webBotAuthHeaders(url, signer, { signatureAgent: `https://${self.host}` }) : {};
      return fetch(url, { ...init, headers: { ...headers, ...signed } });
    }) as typeof fetch;

    let report;
    try {
      report = await checkTarget(target, { registryUrl: self.origin, method, noRdap, fetch: f });
    } catch (e) {
      return bad(c, `${(e as Error).message}. ${USAGE}`);
    }
    const body = { ...report, next: nextStep(report), cachedAt: new Date().toISOString() };
    c.executionCtx.waitUntil(caches.default.put(key, new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": `max-age=${TTL}` } })));
    return c.json(body, 200, { "cache-control": `public, max-age=${TTL}` });
  };
}
