import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { sha256Hex, verify, fromBase64 } from "../crypto/keys.js";
import { unauthorized } from "./errors.js";

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
 *   inam-signature:  base64 Ed25519 signature over:
 *     `${METHOD}\n${path}\n${timestamp}\n${sha256hex(rawBody)}`
 */
export function requireSignedRequest(req: Request, _res: Response, next: NextFunction) {
  const agentDid = req.header("inam-agent");
  const timestamp = req.header("inam-timestamp");
  const signatureB64 = req.header("inam-signature");

  if (!agentDid || !timestamp || !signatureB64) {
    throw unauthorized("MISSING_SIGNATURE", "inam-agent, inam-timestamp and inam-signature headers are required");
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
  const signingString = `${req.method.toUpperCase()}\n${pathOnly}\n${timestamp}\n${bodyHash}`;

  let signatureOk = false;
  try {
    signatureOk = verify(fromBase64(signatureB64), new TextEncoder().encode(signingString), agentDid);
  } catch {
    signatureOk = false;
  }

  if (!signatureOk) {
    throw unauthorized("INVALID_SIGNATURE", "Signature does not match the claimed agent DID for this request");
  }

  req.agentDid = agentDid;
  next();
}
