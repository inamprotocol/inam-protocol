import type { Context, Next } from "hono";
import { sha256Hex, verify, fromBase64 } from "../../sdk-js/src/crypto/keys.js";
import { buildSigningStringV1, buildSigningStringV2, SIG_VERSION_HEADER } from "../../sdk-js/src/core/signingString.js";
import { unauthorized, badRequest, forbidden } from "./errors.js";
import * as db from "./db.js";
import type { AppEnv } from "./types.js";

const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Same simplified, RFC 9421-inspired scheme as the Node reference server
 * (src/middleware/signedRequest.ts) — see that file's doc comment for the
 * header contract, and sdk-js/src/core/signingString.ts for the v1/v2
 * signing-string shapes and why v2 exists (host-binding, round-2
 * sub-finding-7). Reads the raw body once and stashes both the raw text and
 * the parsed JSON on the context so route handlers never re-read the stream.
 */
export async function requireSignedRequest(c: Context<AppEnv>, next: Next) {
  const agentDid = c.req.header("inam-agent");
  const timestamp = c.req.header("inam-timestamp");
  const signatureB64 = c.req.header("inam-signature");
  const sigVersion = c.req.header(SIG_VERSION_HEADER);

  if (!agentDid || !timestamp || !signatureB64) {
    throw unauthorized("MISSING_SIGNATURE", "inam-agent, inam-timestamp and inam-signature headers are required");
  }
  if (sigVersion !== undefined && sigVersion !== "2") {
    throw unauthorized("UNSUPPORTED_SIG_VERSION", `Unsupported inam-sig-version "${sigVersion}"`);
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > CLOCK_SKEW_MS) {
    throw unauthorized("STALE_SIGNATURE", "Timestamp is missing, malformed, or outside the allowed clock skew");
  }

  const rawBody = await c.req.text();
  const bodyHash = sha256Hex(rawBody);
  const signingString =
    sigVersion === "2"
      ? buildSigningStringV2(c.req.method, c.req.path, c.req.header("host") ?? "", timestamp, bodyHash)
      : buildSigningStringV1(c.req.method, c.req.path, timestamp, bodyHash);

  let signatureOk = false;
  try {
    signatureOk = verify(fromBase64(signatureB64), new TextEncoder().encode(signingString), agentDid);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw unauthorized("INVALID_SIGNATURE", "Signature does not match the claimed agent DID for this request");
  }

  // A revoked INAM ID (SPEC.md §2.2) can perform no further signed
  // operations — checked here, the one choke point every signed route passes
  // through. An unregistered DID (a fresh registration) isn't in D1 yet, so
  // this is a no-op for it. One extra D1 read per signed write; writes are
  // rate-limited and not latency-critical.
  const record = await db.getAgent(c.env, agentDid);
  if (record?.revokedAt) {
    throw forbidden("AGENT_REVOKED", `This INAM ID was revoked at ${record.revokedAt} and can no longer perform signed operations`);
  }

  c.set("agentDid", agentDid);
  c.set("rawBody", rawBody);
  if (rawBody.length > 0) {
    try {
      c.set("parsedBody", JSON.parse(rawBody));
    } catch {
      // A malformed body (e.g. `{invalid`) previously reached app.onError's
      // catch-all as an uncaught SyntaxError and surfaced as a 500
      // INTERNAL_ERROR -- confirmed live before this fix, same underlying
      // bug as the Node reference server's equivalent (src/middleware/
      // errors.ts) had. A client mistake, not a server bug.
      throw badRequest("INVALID_JSON", "Request body is not valid JSON");
    }
  } else {
    c.set("parsedBody", undefined);
  }
  await next();
}

/**
 * Same verification as requireSignedRequest, for read-only (GET) endpoints
 * where a caller identity is only needed to decide whether it may see
 * `participants_only` receipt content (SPEC.md §4.4) — never required. No
 * signature headers at all -> anonymous (`agentDid` stays unset). Headers
 * present but invalid still reject, same reasoning as the Node reference
 * server's identical helper (src/middleware/signedRequest.ts). Both SDKs
 * already sign every request unconditionally, so this is transparent to
 * any SDK-based caller.
 */
export async function optionalSignedRequest(c: Context<AppEnv>, next: Next) {
  if (!c.req.header("inam-agent") && !c.req.header("inam-timestamp") && !c.req.header("inam-signature")) {
    return next();
  }
  return requireSignedRequest(c, next);
}
