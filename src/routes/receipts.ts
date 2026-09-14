import { Router } from "express";
import { draftReceiptSchema, countersignSchema, disputeSchema, resolveDisputeSchema } from "../../sdk-js/src/core/schemas.js";
import { requireSignedRequest, optionalSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";
import * as receiptService from "../services/receiptService.js";
import * as verificationService from "../services/verificationService.js";

export const receiptsRouter = Router();

// SPEC.md §4.4 (v0.19): whether `callerDid` counts as a verifier of this
// receipt requires a verificationService lookup, done here (not inside
// receiptService, to avoid a receiptService <-> verificationService import
// cycle — verificationService already imports receiptService).
function callerIsVerifierOf(receiptId: string, callerDid: string | undefined): boolean {
  if (!callerDid) return false;
  return verificationService.listByReceipt(receiptId).some((v) => v.verifier === callerDid);
}

receiptsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = draftReceiptSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const receipt = receiptService.createDraft(req.agentDid!, parsed.data);
  res.status(201).json(receipt);
});

receiptsRouter.get("/:id", optionalSignedRequest, (req, res) => {
  const receipt = receiptService.getReceipt(req.params.id);
  receiptService.assertReceiptVisible(receipt, req.agentDid, callerIsVerifierOf(receipt.receiptId, req.agentDid));
  res.json(receipt);
});

receiptsRouter.get("/:id/verifications", optionalSignedRequest, (req, res) => {
  const receipt = receiptService.getReceipt(req.params.id);
  const records = verificationService.listByReceipt(req.params.id);
  const isVerifier = req.agentDid ? records.some((v) => v.verifier === req.agentDid) : false;
  receiptService.assertReceiptVisible(receipt, req.agentDid, isVerifier);
  res.json({ verifications: records });
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

// The dispute's opener withdraws it (SPEC.md §4.3): disputed -> finalized.
receiptsRouter.post("/:id/dispute/resolve", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = resolveDisputeSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  res.json(receiptService.resolveDispute(req.params.id, req.agentDid!, parsed.data.note));
});
