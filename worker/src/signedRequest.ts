import type { Context, Next } from "hono";
import { sha256Hex, verify, fromBase64 } from "../../sdk-js/src/crypto/keys.js";
import { unauthorized } from "./errors.js";
import type { AppEnv } from "./types.js";

const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Same simplified, RFC 9421-inspired scheme as the Node reference server
 * (src/middleware/signedRequest.ts) — see that file's doc comment for the
 * header contract. Reads the raw body once and stashes both the raw text and
 * the parsed JSON on the context so route handlers never re-read the stream.
 */
export async function requireSignedRequest(c: Context<AppEnv>, next: Next) {
  const agentDid = c.req.header("inam-agent");
  const timestamp = c.req.header("inam-timestamp");
  const signatureB64 = c.req.header("inam-signature");

  if (!agentDid || !timestamp || !signatureB64) {
    throw unauthorized("MISSING_SIGNATURE", "inam-agent, inam-timestamp and inam-signature headers are required");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) {
    throw unauthorized("STALE_SIGNATURE", "Timestamp is missing, malformed, or outside the allowed clock skew");
  }

  const rawBody = await c.req.text();
  const bodyHash = sha256Hex(rawBody);
  const signingString = `${c.req.method.toUpperCase()}\n${c.req.path}\n${timestamp}\n${bodyHash}`;

  let signatureOk = false;
  try {
    signatureOk = verify(fromBase64(signatureB64), new TextEncoder().encode(signingString), agentDid);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw unauthorized("INVALID_SIGNATURE", "Signature does not match the claimed agent DID for this request");
  }

  c.set("agentDid", agentDid);
  c.set("rawBody", rawBody);
  c.set("parsedBody", rawBody.length > 0 ? JSON.parse(rawBody) : undefined);
  await next();
}
