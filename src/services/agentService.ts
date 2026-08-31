import { randomBytes, randomUUID } from "node:crypto";
import { agents, linkChallenges } from "../storage/db.js";
import { config } from "../config.js";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errors.js";
import { fromBase64, fromHex, toHex, verifyRawEd25519 } from "../../sdk-js/src/crypto/keys.js";
import { p256Verify } from "../../sdk-js/src/crypto/p256.js";
import type { AgentRecord, ExternalKeyType, LinkChallenge, LinkedIdentities, LinkedIdentityProofs, LinkProof } from "../types.js";

export function registerAgent(callerDid: string, input: { capabilities: string[]; metadata?: Record<string, unknown> }): AgentRecord {
  if (agents.has(callerDid)) {
    throw conflict("AGENT_ALREADY_REGISTERED", `Agent ${callerDid} is already registered`);
  }
  const record: AgentRecord = {
    id: callerDid,
    capabilities: input.capabilities,
    metadata: input.metadata ?? {},
    linked: {},
    linkedProof: {},
    stakeUsd: 0,
    createdAt: new Date().toISOString(),
    // Never settable at registration -- an agent cannot make itself a
    // verifier by self-registering (SPEC.md §12.3). Only setVerifierStatus
    // below, callable solely by config.operatorDid, can flip this.
    isAuthorizedVerifier: false,
  };
  agents.set(callerDid, record);
  return record;
}

export function getAgent(id: string): AgentRecord {
  const record = agents.get(id);
  if (!record) throw notFound("AGENT_NOT_FOUND", `No agent registered with id ${id}`);
  // `linkedProof` (SPEC.md v0.13) — default it so a record persisted before
  // the field existed still returns a consistent shape.
  return { ...record, linkedProof: record.linkedProof ?? {} };
}

/**
 * Grants or revokes an agent's verifier status (SPEC.md §12.3). Callable
 * only by the registry's configured operator identity (config.operatorDid)
 * — an audit found that letting *any* registered agent act as a verifier
 * (the only bar being "not a party to this receipt") meant verifier count
 * didn't correspond to real independence: anyone could self-register and
 * immediately start verifying. `config.operatorDid` unset (the default
 * until a deployment deliberately configures it) means this always rejects
 * — locked down, not silently permissive.
 */
export function setVerifierStatus(callerDid: string, targetAgentId: string, authorized: boolean): AgentRecord {
  if (!config.operatorDid || callerDid !== config.operatorDid) {
    throw forbidden("NOT_OPERATOR", "Only the registry's configured operator identity may authorize or revoke a verifier");
  }
  const record = getAgent(targetAgentId);
  const updated: AgentRecord = { ...record, isAuthorizedVerifier: authorized };
  agents.set(targetAgentId, updated);
  return updated;
}

const LINKABLE_PROTOCOLS = ["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"] as const;
type LinkableProtocol = (typeof LINKABLE_PROTOCOLS)[number];

/** Key-identity protocols require cryptographic proof of control via the
 * challenge/response flow below. `a2a_endpoint` is just a service URL, not a
 * key-derived identity, so it stays a plain unchecked claim. */
const CHALLENGEABLE_PROTOCOLS = ["agentpass_id", "aitp_id", "passport_id"] as const;
type ChallengeableProtocol = (typeof CHALLENGEABLE_PROTOCOLS)[number];

const KEY_TYPES = ["ed25519", "p256"] as const;

function assertLinkableProtocol(protocol: string): asserts protocol is LinkableProtocol {
  if (!LINKABLE_PROTOCOLS.includes(protocol as LinkableProtocol)) {
    throw badRequest("UNSUPPORTED_PROTOCOL", `protocol must be one of: ${LINKABLE_PROTOCOLS.join(", ")}`);
  }
}

/**
 * Links `a2a_endpoint` — a plain service URL, not a key-derived identity, so
 * there's nothing to prove control of beyond the INAM signature already on
 * this request (which is enforced by requireSignedRequest + requireSelf).
 */
export function linkEndpoint(callerDid: string, protocol: string, value: string): AgentRecord {
  assertLinkableProtocol(protocol);
  if ((CHALLENGEABLE_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw badRequest("CHALLENGE_REQUIRED", `${protocol} is a key-derived identity and must be linked via POST /agents/:id/link/challenge first, not this endpoint`);
  }
  const record = getAgent(callerDid);
  const linked: LinkedIdentities = { ...record.linked, [protocol]: value };
  // a2a_endpoint carries no external proof — it's a bare URL the agent
  // asserted, backed only by the INAM signature on this request. Record that
  // honestly so a consumer doesn't read it as a verified identity binding.
  const linkedProof: LinkedIdentityProofs = {
    ...record.linkedProof,
    [protocol]: { method: "unverified_claim", verifiedAt: new Date().toISOString() } satisfies LinkProof,
  };
  const updated: AgentRecord = { ...record, linked, linkedProof };
  agents.set(callerDid, updated);
  return updated;
}

/**
 * Step 1 of linking a key-derived external identity (agentpass_id / aitp_id /
 * passport_id): issue a single-use, short-lived random challenge the caller
 * must sign with the *external* private key they're claiming to control.
 * Wire format follows ATTP §4 (draft-sharif-attp-00, the protocol AgentPass
 * is built on) since it's the one publicly-specified byte format among the
 * three: 32 random bytes hex-encoded, ECDSA-P256 or Ed25519, 60s expiry,
 * single use. This proves possession of the claimed key — it does not (yet)
 * call out to AgentPass/AITP/Passport Alliance's own registries to confirm
 * that key is the one they currently recognize as authoritative for that
 * identity; that live-resolution step is the next increment beyond this one.
 */
export function requestLinkChallenge(callerDid: string, protocol: string, externalPublicKeyB64: string, keyType: string): LinkChallenge {
  if (!(CHALLENGEABLE_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw badRequest("UNSUPPORTED_PROTOCOL", `protocol must be one of: ${CHALLENGEABLE_PROTOCOLS.join(", ")}`);
  }
  if (!(KEY_TYPES as readonly string[]).includes(keyType)) {
    throw badRequest("UNSUPPORTED_KEY_TYPE", `keyType must be one of: ${KEY_TYPES.join(", ")}`);
  }
  getAgent(callerDid); // 404s if the caller isn't a registered agent
  const challengeId = randomUUID();
  const now = Date.now();
  const record = {
    challengeId,
    agentId: callerDid,
    protocol,
    externalPublicKey: externalPublicKeyB64,
    keyType: keyType as ExternalKeyType,
    challenge: toHex(randomBytes(32)),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + config.linkChallengeTtlMs).toISOString(),
    used: false,
  };
  linkChallenges.set(challengeId, record);
  return { challengeId, challenge: record.challenge, expiresAt: record.expiresAt };
}

/**
 * Step 2: consume the challenge — verify the caller actually holds the
 * private key for the external public key they registered in step 1 — and
 * only then write the link.
 */
export function completeLink(callerDid: string, protocol: string, value: string, challengeId: string, proofSignatureB64: string): AgentRecord {
  const record = linkChallenges.get(challengeId);
  if (!record) throw notFound("CHALLENGE_NOT_FOUND", `No challenge with id ${challengeId}`);
  if (record.agentId !== callerDid || record.protocol !== protocol) {
    throw badRequest("CHALLENGE_MISMATCH", "This challenge was not issued for this agent/protocol pair");
  }
  if (record.used) throw conflict("CHALLENGE_ALREADY_USED", "This challenge has already been consumed");
  if (Date.now() > new Date(record.expiresAt).getTime()) throw badRequest("CHALLENGE_EXPIRED", "This challenge has expired — request a new one");

  const challengeBytes = fromHex(record.challenge);
  const publicKeyBytes = fromBase64(record.externalPublicKey);
  const signatureBytes = fromBase64(proofSignatureB64);
  const verified =
    record.keyType === "ed25519"
      ? verifyRawEd25519(signatureBytes, challengeBytes, publicKeyBytes)
      : p256Verify(signatureBytes, challengeBytes, publicKeyBytes);
  if (!verified) {
    throw badRequest("PROOF_INVALID", "Challenge signature does not verify against the claimed external public key");
  }

  record.used = true;
  linkChallenges.set(challengeId, record);

  const agentRecord = getAgent(callerDid);
  const linked: LinkedIdentities = { ...agentRecord.linked, [protocol]: value };
  // Record *what was actually proven*: possession of this specific external
  // key at this moment. Not a claim that the key is the one AgentPass/AITP/
  // Passport Alliance currently recognizes as authoritative for `value` --
  // that live cross-registry check is out of scope (SPEC.md §10). Keeping the
  // key means a consumer can re-check it, and it's the anchor a future
  // resolution step would compare against.
  const linkedProof: LinkedIdentityProofs = {
    ...agentRecord.linkedProof,
    [protocol]: {
      method: "key_possession",
      verifiedAt: new Date().toISOString(),
      keyType: record.keyType,
      externalPublicKey: record.externalPublicKey,
    } satisfies LinkProof,
  };
  const updated: AgentRecord = { ...agentRecord, linked, linkedProof };
  agents.set(callerDid, updated);
  return updated;
}

export function requireSelf(callerDid: string | undefined, subjectId: string) {
  if (!callerDid || callerDid !== subjectId) {
    throw forbidden("NOT_SUBJECT_AGENT", "This operation must be signed by the agent it concerns");
  }
}

export interface SearchQuery {
  capability?: string;
  minReputation?: number;
  supports?: string;
}

export function searchAgents(query: SearchQuery): AgentRecord[] {
  return agents.all().filter((a) => {
    if (query.capability && !a.capabilities.includes(query.capability)) return false;
    if (query.supports && !(query.supports in a.linked)) return false;
    return true;
  });
}
