import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { sha256Hex, verify, fromBase64 } from "../../sdk-js/src/crypto/keys.js";
import { buildSigningStringV1, buildSigningStringV2, SIG_VERSION_HEADER } from "../../sdk-js/src/core/signingString.js";
import { agents } from "../storage/db.js";
import { unauthorized, forbidden } from "./errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      agentDid?: string;
    }
  }
}

/**
 * Simplified, RFC 9421-inspired request signing: not a full implementation of
 * HTTP Message Signatures (the structured-field grammar there is more
 * elaborate), but the same core idea — the caller proves control of a DID's
 * private key over the exact request being made, so there is no separate
 * "API key" concept. Upgrade path: swap this for a spec-compliant
 * Signature-Input/Signature header parser once a mature Node library exists.
 *
 * Required headers:
 *   inam-agent:      did:key:z...            (claimed caller identity)
 *   inam-timestamp:  unix ms                  (replay window)
 *   inam-signature:  base64 Ed25519 signature over the signing string
 *   inam-sig-version: "2" (optional, see below)
 *
 * v2 signing string (current SDKs): `${METHOD}\n${path}\n${host}\n${timestamp}\n${sha256hex(rawBody)}`
 * v1 signing string (legacy, still accepted): `${METHOD}\n${path}\n${timestamp}\n${sha256hex(rawBody)}`
 *
 * `host` in v2 is always THIS server's own actual incoming Host header, never
 * a client-supplied value — see sdk-js/src/core/signingString.ts for why.
 */
export function requireSignedRequest(req: Request, _res: Response, next: NextFunction) {
  const agentDid = req.header("inam-agent");
  const timestamp = req.header("inam-timestamp");
  const signatureB64 = req.header("inam-signature");
  const sigVersion = req.header(SIG_VERSION_HEADER);

  if (!agentDid || !timestamp || !signatureB64) {
    throw unauthorized("MISSING_SIGNATURE", "inam-agent, inam-timestamp and inam-signature headers are required");
  }
  if (sigVersion !== undefined && sigVersion !== "2") {
    throw unauthorized("UNSUPPORTED_SIG_VERSION", `Unsupported inam-sig-version "${sigVersion}"`);
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > config.clockSkewMs) {
    throw unauthorized("STALE_SIGNATURE", "Timestamp is missing, malformed, or outside the allowed clock skew");
  }

  // req.path is relative to the mount point of whichever router matched
  // (e.g. "/:id/link" instead of "/v1/agents/:id/link"), but the client signs
  // the full request path it actually calls — so we must use req.originalUrl
  // here too, or every signature on a sub-routed endpoint would fail to verify.
  const pathOnly = req.originalUrl.split("?")[0];
  const bodyHash = sha256Hex(req.rawBody ?? Buffer.alloc(0));
  const signingString =
    sigVersion === "2"
      ? buildSigningStringV2(req.method, pathOnly, req.header("host") ?? "", timestamp, bodyHash)
      : buildSigningStringV1(req.method, pathOnly, timestamp, bodyHash);

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
  // operations — checked here, the one choke point every signed route
  // already passes through. An unregistered DID (e.g. a fresh registration)
  // isn't in the store yet, so this is a no-op for it.
  const record = agents.get(agentDid);
  if (record?.revokedAt) {
    throw forbidden("AGENT_REVOKED", `This INAM ID was revoked at ${record.revokedAt} and can no longer perform signed operations`);
  }

  req.agentDid = agentDid;
  next();
}

/**
 * Same verification as requireSignedRequest, for read-only (GET) endpoints
 * where a caller identity is only needed to decide whether it may see
 * `participants_only` receipt content (SPEC.md §4.4) — never required.
 * No signature headers at all -> anonymous (req.agentDid stays undefined,
 * the caller just gets the public-only view). Headers present but invalid
 * still reject: a caller that bothers to sign a GET and gets it wrong is
 * worth surfacing, not silently downgrading to "anonymous". Both SDKs
 * already sign every request unconditionally (see sdk-js/src/client.ts's
 * `request()`), so this is transparent to any SDK-based caller and only
 * matters for a raw-HTTP/curl caller, which stays anonymous as before.
 */
export function optionalSignedRequest(req: Request, res: Response, next: NextFunction) {
  if (!req.header("inam-agent") && !req.header("inam-timestamp") && !req.header("inam-signature")) {
    return next();
  }
  requireSignedRequest(req, res, next);
}
