import * as db from "./db.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import { fromBase64, fromHex, toHex, verifyRawEd25519 } from "../../sdk-js/src/crypto/keys.js";
import { p256Verify } from "../../sdk-js/src/crypto/p256.js";
import type { AgentRecord, Env, ExternalKeyType, LinkChallenge, LinkedIdentities } from "./types.js";

export async function registerAgent(
  env: Env,
  callerDid: string,
  input: { capabilities: string[]; metadata?: Record<string, unknown> },
): Promise<AgentRecord> {
  const record: AgentRecord = {
    id: callerDid,
    capabilities: input.capabilities,
    metadata: input.metadata ?? {},
    linked: {},
    stakeUsd: 0,
    createdAt: new Date().toISOString(),
  };
  try {
    await db.insertAgent(env, record);
  } catch (err) {
    if (err instanceof db.AgentAlreadyExistsError) {
      throw conflict("AGENT_ALREADY_REGISTERED", `Agent ${callerDid} is already registered`);
    }
    throw err;
  }
  return record;
}

export async function getAgent(env: Env, id: string): Promise<AgentRecord> {
  const record = await db.getAgent(env, id);
  if (!record) throw notFound("AGENT_NOT_FOUND", `No agent registered with id ${id}`);
  return record;
}

const LINKABLE_PROTOCOLS = ["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"] as const;
type LinkableProtocol = (typeof LINKABLE_PROTOCOLS)[number];

/** Key-identity protocols require cryptographic proof of control via the
 * challenge/response flow below. `a2a_endpoint` is just a service URL, not a
 * key-derived identity, so it stays a plain unchecked claim. */
const CHALLENGEABLE_PROTOCOLS = ["agentpass_id", "aitp_id", "passport_id"] as const;
const KEY_TYPES = ["ed25519", "p256"] as const;
const LINK_CHALLENGE_TTL_MS = 60 * 1000; // ATTP §4: "expiration window not exceeding 60 seconds"

function assertLinkableProtocol(protocol: string): asserts protocol is LinkableProtocol {
  if (!LINKABLE_PROTOCOLS.includes(protocol as LinkableProtocol)) {
    throw badRequest("UNSUPPORTED_PROTOCOL", `protocol must be one of: ${LINKABLE_PROTOCOLS.join(", ")}`);
  }
}

/** Links `a2a_endpoint` — a plain service URL, nothing to prove control of
 * beyond the INAM signature already required on this request. */
export async function linkEndpoint(env: Env, callerDid: string, protocol: string, value: string): Promise<AgentRecord> {
  assertLinkableProtocol(protocol);
  if ((CHALLENGEABLE_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw badRequest("CHALLENGE_REQUIRED", `${protocol} is a key-derived identity and must be linked via POST /agents/:id/link/challenge first, not this endpoint`);
  }
  const record = await getAgent(env, callerDid);
  const linked: LinkedIdentities = { ...record.linked, [protocol]: value };
  await db.updateAgentLinked(env, callerDid, linked);
  return { ...record, linked };
}

/**
 * Step 1: issue a single-use, ~60s challenge the caller must sign with the
 * external private key they're claiming to control. Wire format follows ATTP
 * §4 (draft-sharif-attp-00, the protocol AgentPass is built on): 32 random
 * bytes hex-encoded, ECDSA-P256 or Ed25519. Proves possession of the claimed
 * key — does not (yet) call out to AgentPass/AITP/Passport Alliance's own
 * registries to confirm that key is currently authoritative for the claimed
 * identity; that live-resolution step is the next increment beyond this one.
 */
export async function requestLinkChallenge(env: Env, callerDid: string, protocol: string, externalPublicKeyB64: string, keyType: string): Promise<LinkChallenge> {
  if (!(CHALLENGEABLE_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw badRequest("UNSUPPORTED_PROTOCOL", `protocol must be one of: ${CHALLENGEABLE_PROTOCOLS.join(", ")}`);
  }
  if (!(KEY_TYPES as readonly string[]).includes(keyType)) {
    throw badRequest("UNSUPPORTED_KEY_TYPE", `keyType must be one of: ${KEY_TYPES.join(", ")}`);
  }
  await getAgent(env, callerDid); // 404s if the caller isn't a registered agent

  const challengeId = crypto.randomUUID();
  const now = Date.now();
  const challengeBytes = new Uint8Array(32);
  crypto.getRandomValues(challengeBytes);
  const record = {
    challengeId,
    agentId: callerDid,
    protocol,
    externalPublicKey: externalPublicKeyB64,
    keyType: keyType as ExternalKeyType,
    challenge: toHex(challengeBytes),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LINK_CHALLENGE_TTL_MS).toISOString(),
    used: false,
  };
  await db.insertLinkChallenge(env, record);
  return { challengeId, challenge: record.challenge, expiresAt: record.expiresAt };
}

/** Step 2: consume the challenge (compare-and-swap — see db.ts) and verify
 * the proof signature before writing the link. */
export async function completeLink(env: Env, callerDid: string, protocol: string, value: string, challengeId: string, proofSignatureB64: string): Promise<AgentRecord> {
  const record = await db.getLinkChallenge(env, challengeId);
  if (!record) throw notFound("CHALLENGE_NOT_FOUND", `No challenge with id ${challengeId}`);
  if (record.agentId !== callerDid || record.protocol !== protocol) {
    throw badRequest("CHALLENGE_MISMATCH", "This challenge was not issued for this agent/protocol pair");
  }
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

  const consumed = await db.consumeLinkChallengeIfUnused(env, challengeId);
  if (!consumed) throw conflict("CHALLENGE_ALREADY_USED", "This challenge has already been consumed");

  const agentRecord = await getAgent(env, callerDid);
  const linked: LinkedIdentities = { ...agentRecord.linked, [protocol]: value };
  await db.updateAgentLinked(env, callerDid, linked);
  return { ...agentRecord, linked };
}

export function requireSelf(callerDid: string | undefined, subjectId: string) {
  if (!callerDid || callerDid !== subjectId) {
    throw forbidden("NOT_SUBJECT_AGENT", "This operation must be signed by the agent it concerns");
  }
}

export interface SearchQuery {
  capability?: string;
  supports?: string;
}

export async function searchAgents(env: Env, query: SearchQuery): Promise<AgentRecord[]> {
  const all = await db.allAgents(env);
  return all.filter((a) => {
    if (query.capability && !a.capabilities.includes(query.capability)) return false;
    if (query.supports && !(query.supports in a.linked)) return false;
    return true;
  });
}
