import type { InamClient } from "./client.js";
import type { AgentRecord, ReputationResult } from "./types.js";
import { policyFailure, type X402Policy } from "./x402.js";

/** INAM reputation on an A2A Agent Card (SPEC.md §11.3).
 *
 * A data-only A2A extension: the card names its INAM ID, and a client
 * accepts it only if that ID has, with its own key, linked the same service
 * endpoint (`linked.a2a_endpoint`, SPEC.md §2). Both sides name each other,
 * so a card can't borrow a reputable agent's ID and an ID can't adopt
 * someone else's endpoint. */

export const INAM_A2A_EXTENSION_URI = "https://inamprotocol.org/ext/a2a/v1";

export type A2APolicy = X402Policy;

export interface A2ADecision {
  allow: boolean;
  reason: string;
  did?: string;
  reputation?: ReputationResult;
}

interface AgentExtension { uri: string; params?: { did?: unknown } }
/** The parts of an A2A Agent Card this check reads: v1.0 `supportedInterfaces`, v0.3 `url`/`additionalInterfaces`. */
export interface A2AAgentCardLike {
  url?: string;
  supportedInterfaces?: { url: string }[];
  additionalInterfaces?: { url: string }[];
  capabilities?: { extensions?: AgentExtension[] };
}

/** The `capabilities.extensions` entry an agent adds to its card. Never `required`: it is data-only. */
export function inamA2AExtension(did: string) {
  return {
    uri: INAM_A2A_EXTENSION_URI,
    description: "This agent's INAM ID. Verify it links this endpoint, then read its receipt-based reputation.",
    required: false,
    params: { did },
  };
}

function normalize(u: string): string | null {
  try {
    return new URL(u).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function cardEndpoints(card: A2AAgentCardLike): string[] {
  return [card.url, ...(card.supportedInterfaces ?? []), ...(card.additionalInterfaces ?? [])]
    .map((x) => (typeof x === "string" ? x : x?.url))
    .filter((x): x is string => typeof x === "string");
}

/** Pure check, for callers that already fetched the agent and its reputation. */
export function decideA2A(card: A2AAgentCardLike, agent: AgentRecord, reputation: ReputationResult, policy: A2APolicy = {}): A2ADecision {
  const base = { did: agent.id, reputation };
  if (agent.revokedAt) return { ...base, allow: false, reason: "INAM ID is revoked" };
  const linked = agent.linked.a2a_endpoint && normalize(agent.linked.a2a_endpoint);
  if (!linked || !cardEndpoints(card).some((u) => normalize(u) === linked)) {
    return { ...base, allow: false, reason: "no endpoint on this card is the a2a_endpoint the INAM ID linked" };
  }
  const failed = policyFailure(reputation, policy);
  return failed ? { ...base, allow: false, reason: failed } : { ...base, allow: true, reason: "ok" };
}

/** Reads the INAM extension off a card and checks it against the registry `inam` points at. */
export async function verifyA2ACard(card: A2AAgentCardLike, inam: InamClient, policy: A2APolicy = {}): Promise<A2ADecision> {
  const did = card.capabilities?.extensions?.find((e) => e.uri === INAM_A2A_EXTENSION_URI)?.params?.did;
  if (typeof did !== "string") return { allow: false, reason: "card names no INAM ID" };
  let agent: AgentRecord, reputation: ReputationResult;
  try {
    [agent, reputation] = await Promise.all([inam.getAgent(did), inam.getReputation(did)]);
  } catch {
    return { allow: false, did, reason: "INAM ID not found in the registry" };
  }
  return decideA2A(card, agent, reputation, policy);
}
