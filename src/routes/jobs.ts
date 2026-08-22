import { Router } from "express";
import { z } from "zod";
import { requireSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent, rateLimitReadByIp } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as jobService from "../services/jobService.js";

export const jobsRouter = Router();

const postJobSchema = z.object({
  capability: z.string().min(1),
  specHash: z.string().min(1),
  budget: z.object({ amount: z.string().optional(), currency: z.string().optional() }).optional(),
  expiresAt: z.string().optional(),
});

jobsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = postJobSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.postJob(req.agentDid!, parsed.data);
  res.status(201).json(job);
});

jobsRouter.get("/search", rateLimitReadByIp, (req, res) => {
  const capability = typeof req.query.capability === "string" ? req.query.capability : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  res.json({ jobs: jobService.searchJobs({ capability, status }) });
});

jobsRouter.get("/:id", (req, res) => {
  res.json(jobService.getJob(req.params.id));
});

const offerSchema = z.object({ message: z.string().optional() });

jobsRouter.post("/:id/offers", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = offerSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.submitOffer(req.params.id, req.agentDid!, parsed.data.message);
  res.status(201).json(job);
});

jobsRouter.get("/:id/offers", (req, res) => {
  res.json({ offers: jobService.getJob(req.params.id).offers });
});

const acceptSchema = z.object({ agentId: z.string().min(1) });

jobsRouter.post("/:id/accept", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.acceptOffer(req.params.id, req.agentDid!, parsed.data.agentId);
  res.json(job);
});

jobsRouter.post("/:id/cancel", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const job = jobService.cancelJob(req.params.id, req.agentDid!);
  res.json(job);
});
