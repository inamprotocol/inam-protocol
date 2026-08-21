import { agents } from "../storage/db.js";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errors.js";
import type { AgentRecord, LinkedIdentities } from "../types.js";

export function registerAgent(callerDid: string, input: { capabilities: string[]; metadata?: Record<string, unknown> }): AgentRecord {
  if (agents.has(callerDid)) {
    throw conflict("AGENT_ALREADY_REGISTERED", `Agent ${callerDid} is already registered`);
  }
  const record: AgentRecord = {
    id: callerDid,
    capabilities: input.capabilities,
    metadata: input.metadata ?? {},
    linked: {},
    stakeUsd: 0,
    createdAt: new Date().toISOString(),
  };
  agents.set(callerDid, record);
  return record;
}

export function getAgent(id: string): AgentRecord {
  const record = agents.get(id);
  if (!record) throw notFound("AGENT_NOT_FOUND", `No agent registered with id ${id}`);
  return record;
}

const LINKABLE_PROTOCOLS = ["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"] as const;
type LinkableProtocol = (typeof LINKABLE_PROTOCOLS)[number];

/**
 * Links an external identity/protocol to this agent's Inam ID. This
 * reference implementation trusts the caller's self-signed claim (the request
 * itself is signed by the Inam DID being linked, proving control of *that*
 * key) but does not yet call out to AgentPass/AITP/Passport Alliance to
 * independently verify control of the external identity — that
 * challenge-response step is the real next increment before this can be
 * trusted for anything high-stakes.
 */
export function linkIdentity(callerDid: string, protocol: string, value: string): AgentRecord {
  if (!LINKABLE_PROTOCOLS.includes(protocol as LinkableProtocol)) {
    throw badRequest("UNSUPPORTED_PROTOCOL", `protocol must be one of: ${LINKABLE_PROTOCOLS.join(", ")}`);
  }
  const record = getAgent(callerDid);
  const linked: LinkedIdentities = { ...record.linked, [protocol]: value };
  const updated: AgentRecord = { ...record, linked };
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
