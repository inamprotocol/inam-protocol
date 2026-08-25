import { Router } from "express";
import { draftReceiptSchema, countersignSchema, disputeSchema } from "../../sdk-js/src/core/schemas.js";
import { requireSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as receiptService from "../services/receiptService.js";
import * as verificationService from "../services/verificationService.js";

export const receiptsRouter = Router();

receiptsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = draftReceiptSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const receipt = receiptService.createDraft(req.agentDid!, parsed.data);
  res.status(201).json(receipt);
});

receiptsRouter.get("/:id", (req, res) => {
  res.json(receiptService.getReceipt(req.params.id));
});

receiptsRouter.get("/:id/verifications", (req, res) => {
  res.json({ verifications: verificationService.listByReceipt(req.params.id) });
});

receiptsRouter.post("/:id/countersign", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = countersignSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const receipt = receiptService.countersign(req.params.id, req.agentDid!, parsed.data.signature);
  res.json(receipt);
});

receiptsRouter.post("/:id/dispute", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = disputeSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const receipt = receiptService.openDispute(req.params.id, req.agentDid!, parsed.data.reason);
  res.json(receipt);
});
