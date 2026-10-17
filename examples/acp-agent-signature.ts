import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { generateKeypair, canonicalize, sign, verify, fromBase64 } from "../sdk-js/src/index.js";

/** A merchant that stores WHO the agent is, for ACP checkout (the gap in
 * agentic-commerce-protocol#315, "merchant has no stored agent identity").
 *
 * What ACP says today (rfc.agentic_checkout.md): the client SHOULD send `Signature`
 * (base64url) over canonical JSON of the body with a `Timestamp` (RFC 3339), and the
 * server publishes the acceptable algorithms out of band (section 2.1). It names no
 * agent identifier. This example makes the out-of-band choice explicit:
 *
 *   - algorithm: Ed25519; the key is a did:key, so the DID names the agent AND carries
 *     the public key: a merchant verifies with no lookup and no registry.
 *   - signed bytes: `${Timestamp}\n${JCS(body)}` (RFC 8785, `canonicalize`).
 *   - identifier: a body field carrying the DID. `agent_identity.did` below is an
 *     ILLUSTRATIVE name, not part of ACP: ACP defines no such field. Being in the body,
 *     it takes part in idempotency comparison (section 6.7) and is covered by the signature.
 *
 * It proves the request came from the holder of that key and was not altered. It does
 * NOT name the platform's legal entity or the end user, and whether card networks accept
 * it as evidence in representment is unknown. INAM moves and holds no money.
 *
 *   npx tsx examples/acp-agent-signature.ts     # offline self-check, no network */

const SKEW_MS = 5 * 60 * 1000;
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const bytes = (timestamp: string, body: unknown) => new TextEncoder().encode(`${timestamp}\n${canonicalize(body)}`);

type Agent = ReturnType<typeof generateKeypair>;
export interface SignedRequest { headers: { Signature: string; Timestamp: string; "Idempotency-Key": string }; body: Record<string, unknown> }

/** Agent side: build POST /checkout_sessions with the DID in the body and sign it. */
export function signCheckoutRequest(agent: Agent, items: { id: string; quantity: number }[], now = new Date()): SignedRequest {
  const body = { items, agent_identity: { did: agent.did } };
  const timestamp = now.toISOString();
  return {
    headers: { Signature: b64url(sign(bytes(timestamp, body), agent.privateKey)), Timestamp: timestamp, "Idempotency-Key": crypto.randomUUID() },
    body,
  };
}

/** Merchant side: verify, then return the DID to store next to the checkout session. */
export function verifyCheckoutRequest(req: SignedRequest, now = new Date()): { ok: true; did: string } | { ok: false; reason: string } {
  const did = (req.body as { agent_identity?: { did?: unknown } }).agent_identity?.did;
  if (typeof did !== "string" || !did.startsWith("did:key:")) return { ok: false, reason: "no agent did:key in the body" };
  const age = Math.abs(now.getTime() - Date.parse(req.headers.Timestamp));
  if (!(age <= SKEW_MS)) return { ok: false, reason: "timestamp outside the allowed skew" };
  let ok = false;
  try {
    ok = verify(fromBase64(req.headers.Signature.replace(/-/g, "+").replace(/_/g, "/")), bytes(req.headers.Timestamp, req.body), did);
  } catch {
    // malformed signature or did: treated as invalid below
  }
  return ok ? { ok: true, did } : { ok: false, reason: "signature does not verify for that did:key" };
}

export function selfCheck() {
  const agent = generateKeypair();
  const other = generateKeypair();
  const items = [{ id: "item_123", quantity: 1 }];
  const req = signCheckoutRequest(agent, items);

  assert.deepEqual(verifyCheckoutRequest(req), { ok: true, did: agent.did }); // the merchant stores agent.did with the session

  const tampered = { ...req, body: { ...req.body, items: [{ id: "item_123", quantity: 9 }] } };
  assert.equal(verifyCheckoutRequest(tampered).ok, false); // body changed after signing

  const claimed = { ...req, body: { ...req.body, agent_identity: { did: other.did } } };
  assert.equal(verifyCheckoutRequest(claimed).ok, false); // naming someone else's DID fails: the signature is not theirs

  const later = new Date(Date.now() + 10 * 60 * 1000);
  assert.equal(verifyCheckoutRequest(req, later).ok, false); // stale timestamp

  assert.equal(verifyCheckoutRequest({ ...req, headers: { ...req.headers, Signature: "!!!" } }).ok, false); // malformed signature
  assert.equal(verifyCheckoutRequest({ ...req, body: { items } }).ok, false); // no identity field

  console.log("acp-agent-signature: ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) selfCheck();
