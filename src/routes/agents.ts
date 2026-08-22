import { Router } from "express";
import { z } from "zod";
import { requireSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitRegistrationByIp, rateLimitWriteByAgent, rateLimitReadByIp } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as agentService from "../services/agentService.js";
import { computeReputation } from "../services/reputationService.js";
import { listByAgent } from "../services/receiptService.js";

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

const linkSchema = z.object({
  protocol: z.enum(["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"]),
  value: z.string().min(1),
});

agentsRouter.post("/:id/link", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  agentService.requireSelf(req.agentDid, req.params.id);
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const record = agentService.linkIdentity(req.agentDid!, parsed.data.protocol, parsed.data.value);
  res.json(record);
});

agentsRouter.get("/:id/receipts", (req, res) => {
  res.json({ receipts: listByAgent(req.params.id) });
});
