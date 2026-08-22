import { Router } from "express";
import { z } from "zod";
import { requireSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as verificationService from "../services/verificationService.js";

export const verificationsRouter = Router();

const submitSchema = z.object({
  receiptId: z.string().min(1),
  verifier: z.string().min(1),
  method: z.enum(["deterministic", "agent_attestation"]),
  outputHash: z.string().min(1),
  result: z.enum(["verified", "rejected"]),
  score: z.number().min(0).max(1).optional(),
  evidenceUri: z.string().optional(),
  signature: z.string().min(1),
});

verificationsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const record = verificationService.submitVerification(req.agentDid!, parsed.data);
  res.status(201).json(record);
});

verificationsRouter.get("/:id", (req, res) => {
  res.json(verificationService.getVerification(req.params.id));
});
