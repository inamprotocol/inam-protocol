import * as db from "./db.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { AgentRecord, Env, LinkedIdentities } from "./types.js";

export async function registerAgent(
  env: Env,
  callerDid: string,
  input: { capabilities: string[]; metadata?: Record<string, unknown> },
): Promise<AgentRecord> {
  const existing = await db.getAgent(env, callerDid);
  if (existing) throw conflict("AGENT_ALREADY_REGISTERED", `Agent ${callerDid} is already registered`);
  const record: AgentRecord = {
    id: callerDid,
    capabilities: input.capabilities,
    metadata: input.metadata ?? {},
    linked: {},
    stakeUsd: 0,
    createdAt: new Date().toISOString(),
  };
  await db.putAgent(env, record);
  return record;
}

export async function getAgent(env: Env, id: string): Promise<AgentRecord> {
  const record = await db.getAgent(env, id);
  if (!record) throw notFound("AGENT_NOT_FOUND", `No agent registered with id ${id}`);
  return record;
}

const LINKABLE_PROTOCOLS = ["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"] as const;
type LinkableProtocol = (typeof LINKABLE_PROTOCOLS)[number];

export async function linkIdentity(env: Env, callerDid: string, protocol: string, value: string): Promise<AgentRecord> {
  if (!LINKABLE_PROTOCOLS.includes(protocol as LinkableProtocol)) {
    throw badRequest("UNSUPPORTED_PROTOCOL", `protocol must be one of: ${LINKABLE_PROTOCOLS.join(", ")}`);
  }
  const record = await getAgent(env, callerDid);
  const linked: LinkedIdentities = { ...record.linked, [protocol]: value };
  const updated: AgentRecord = { ...record, linked };
  await db.putAgent(env, updated);
  return updated;
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
