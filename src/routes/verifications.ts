import { Router } from "express";
import { submitVerificationSchema } from "../../sdk-js/src/core/schemas.js";
import { requireSignedRequest, optionalSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as verificationService from "../services/verificationService.js";

export const verificationsRouter = Router();

verificationsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = submitVerificationSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const record = verificationService.submitVerification(req.agentDid!, parsed.data);
  res.status(201).json(record);
});

verificationsRouter.get("/:id", optionalSignedRequest, (req, res) => {
  res.json(verificationService.getVisibleVerification(req.params.id, req.agentDid));
});
