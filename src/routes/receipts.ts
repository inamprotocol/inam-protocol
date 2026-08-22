import { Router } from "express";
import { z } from "zod";
import { requireSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as receiptService from "../services/receiptService.js";
import * as verificationService from "../services/verificationService.js";

export const receiptsRouter = Router();

const draftSchema = z.object({
  jobId: z.string().min(1),
  agentAId: z.string().min(1),
  task: z.object({
    capability: z.string().min(1),
    specHash: z.string().min(1),
    createdAt: z.string().min(1),
  }),
  result: z.object({
    outputHash: z.string().min(1),
    outputUri: z.string().optional(),
    completedAt: z.string().min(1),
  }),
  settlement: z
    .object({
      paymentRef: z.string().optional(),
      amount: z.string().optional(),
      currency: z.string().optional(),
    })
    .optional(),
  verification: z.object({
    method: z.enum(["payer_confirmation", "independent_validator", "test_suite_pass"]),
    verifier: z.string().optional(),
    outcome: z.enum(["success", "partial", "failed"]),
  }),
  signature: z.string().min(1),
});

receiptsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = draftSchema.safeParse(req.body);
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

const countersignSchema = z.object({ signature: z.string().min(1) });

receiptsRouter.post("/:id/countersign", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = countersignSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const receipt = receiptService.countersign(req.params.id, req.agentDid!, parsed.data.signature);
  res.json(receipt);
});

const disputeSchema = z.object({ reason: z.string().min(1) });

receiptsRouter.post("/:id/dispute", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = disputeSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const receipt = receiptService.openDispute(req.params.id, req.agentDid!, parsed.data.reason);
  res.json(receipt);
});
