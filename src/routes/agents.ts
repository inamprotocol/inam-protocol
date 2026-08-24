import { Router } from "express";
import { z } from "zod";
import { requireSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitRegistrationByIp, rateLimitWriteByAgent, rateLimitReadByIp } from "../middleware/rateLimit.js";
import { badRequest, ApiError } from "../middleware/errors.js";
import * as agentService from "../services/agentService.js";
import { computeReputation } from "../services/reputationService.js";
import { listByAgent } from "../services/receiptService.js";
import { badgeDataForReputation, badgeDataToJson, notFoundBadgeData, renderBadgeSvg } from "../services/badgeService.js";

export const agentsRouter = Router();

const registerSchema = z.object({
  capabilities: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.unknown()).optional(),
});

agentsRouter.post("/", rateLimitRegistrationByIp, requireSignedRequest, requireIdempotencyKey, (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const record = agentService.registerAgent(req.agentDid!, parsed.data);
  res.status(201).json(record);
});

agentsRouter.get("/search", rateLimitReadByIp, (req, res) => {
  const capability = typeof req.query.capability === "string" ? req.query.capability : undefined;
  const supports = typeof req.query.supports === "string" ? req.query.supports : undefined;
  const minReputation = req.query.min_reputation ? Number(req.query.min_reputation) : undefined;

  let results = agentService.searchAgents({ capability, supports });
  if (minReputation !== undefined) {
    results = results.filter((a) => computeReputation(a.id).trustScore >= minReputation);
  }
  res.json({ agents: results });
});

agentsRouter.get("/:id", (req, res) => {
  res.json(agentService.getAgent(req.params.id));
});

agentsRouter.get("/:id/protocols", (req, res) => {
  const agent = agentService.getAgent(req.params.id);
  res.json({ linked: agent.linked });
});

agentsRouter.get("/:id/reputation", rateLimitReadByIp, (req, res) => {
  res.json(computeReputation(req.params.id));
});

// Read-only, unsigned, public badge rendering — a sibling of /reputation, not
// a modification of it. Reuses computeReputation() directly rather than
// re-implementing scoring; badgeService.ts only maps its output to a small
// fixed set of colors/labels. AGENT_NOT_FOUND is caught here (rather than
// left to propagate to the JSON error handler) so an unknown did:key still
// renders a valid badge image instead of a raw JSON error / broken <img>.
function badgeDataForAgent(id: string) {
  try {
    return badgeDataForReputation(computeReputation(id));
  } catch (err) {
    if (err instanceof ApiError && err.code === "AGENT_NOT_FOUND") return notFoundBadgeData();
    throw err;
  }
}

agentsRouter.get("/:id/badge.svg", rateLimitReadByIp, (req, res) => {
  const data = badgeDataForAgent(req.params.id);
  res.set("Content-Type", "image/svg+xml; charset=utf-8");
  // Short-lived but cacheable: badges get embedded in other projects' READMEs
  // and hit repeatedly by viewers/crawlers, but are meant to reflect live
  // reputation, so this shouldn't go stale for long either.
  res.set("Cache-Control", "public, max-age=120");
  res.status(200).send(renderBadgeSvg(data));
});

agentsRouter.get("/:id/badge.json", rateLimitReadByIp, (req, res) => {
  const data = badgeDataForAgent(req.params.id);
  res.set("Cache-Control", "public, max-age=120");
  res.status(200).json(badgeDataToJson(data));
});

const linkChallengeSchema = z.object({
  protocol: z.enum(["agentpass_id", "aitp_id", "passport_id"]),
  externalPublicKey: z.string().min(1),
  keyType: z.enum(["ed25519", "p256"]),
});

agentsRouter.post("/:id/link/challenge", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  agentService.requireSelf(req.agentDid, req.params.id);
  const parsed = linkChallengeSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const challenge = agentService.requestLinkChallenge(req.agentDid!, parsed.data.protocol, parsed.data.externalPublicKey, parsed.data.keyType);
  res.status(201).json(challenge);
});

const linkSchema = z.object({
  protocol: z.enum(["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"]),
  value: z.string().min(1),
  challengeId: z.string().min(1).optional(),
  proofSignature: z.string().min(1).optional(),
});

agentsRouter.post("/:id/link", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  agentService.requireSelf(req.agentDid, req.params.id);
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const { protocol, value, challengeId, proofSignature } = parsed.data;
  if (protocol === "a2a_endpoint") {
    res.json(agentService.linkEndpoint(req.agentDid!, protocol, value));
    return;
  }
  if (!challengeId || !proofSignature) {
    throw badRequest("CHALLENGE_REQUIRED", "challengeId and proofSignature are required for key-derived identities — call POST /agents/:id/link/challenge first");
  }
  res.json(agentService.completeLink(req.agentDid!, protocol, value, challengeId, proofSignature));
});

agentsRouter.get("/:id/receipts", (req, res) => {
  res.json({ receipts: listByAgent(req.params.id) });
});
