import { Router } from "express";
import { postJobSchema, offerSchema, acceptOfferSchema, reportNonPerformanceSchema } from "../../sdk-js/src/core/schemas.js";
import { parsePageParams, paginate } from "../../sdk-js/src/core/pagination.js";
import { requireSignedRequest, optionalSignedRequest } from "../middleware/signedRequest.js";
import { requireIdempotencyKey } from "../middleware/idempotency.js";
import { rateLimitWriteByAgent, rateLimitReadByIp } from "../middleware/rateLimit.js";
import { badRequest, forbidden } from "../middleware/errors.js";
import * as jobService from "../services/jobService.js";
import * as receiptService from "../services/receiptService.js";
import * as verificationService from "../services/verificationService.js";
import type { JobRecord } from "../types.js";

export const jobsRouter = Router();

// An external review found GET /jobs/:id and /jobs/search exposed the full
// job record (postedBy, acceptedAgentId, budget, ...) unconditionally, even
// when the job's linked receipt is `participants_only` -- defeating that
// receipt's own visibility setting entirely, since the same parties/amounts
// are readable right off the job. Mirrors receiptService.isReceiptVisible
// (same participants-or-verifier check) against the job's linked receipt.
function isJobVisible(job: JobRecord, callerDid: string | undefined): boolean {
  if (!job.receiptId) return true;
  let receipt;
  try {
    receipt = receiptService.getReceipt(job.receiptId);
  } catch {
    return true;
  }
  const isVerifier = callerDid ? verificationService.listByReceipt(receipt.receiptId).some((v) => v.verifier === callerDid) : false;
  return receiptService.isReceiptVisible(receipt, callerDid, isVerifier);
}

jobsRouter.post("/", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = postJobSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.postJob(req.agentDid!, parsed.data);
  res.status(201).json(job);
});

jobsRouter.get("/search", optionalSignedRequest, rateLimitReadByIp, (req, res) => {
  const capability = typeof req.query.capability === "string" ? req.query.capability : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const visible = jobService.searchJobs({ capability, status }).filter((j) => isJobVisible(j, req.agentDid));
  const rawLimit = typeof req.query.limit === "string" ? req.query.limit : undefined;
  const rawOffset = typeof req.query.offset === "string" ? req.query.offset : undefined;
  const { page, hasMore } = paginate(visible, parsePageParams(rawLimit, rawOffset));
  res.json({ jobs: page, hasMore });
});

jobsRouter.get("/:id", optionalSignedRequest, (req, res) => {
  const job = jobService.getJob(req.params.id);
  if (!isJobVisible(job, req.agentDid)) {
    throw forbidden("JOB_NOT_VISIBLE", "This job's receipt is participants_only; the caller is not a party to it or a verifier who has attested it");
  }
  res.json(job);
});

jobsRouter.post("/:id/offers", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = offerSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.submitOffer(req.params.id, req.agentDid!, parsed.data.message);
  res.status(201).json(job);
});

jobsRouter.get("/:id/offers", (req, res) => {
  res.json({ offers: jobService.getJob(req.params.id).offers });
});

jobsRouter.post("/:id/accept", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = acceptOfferSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.acceptOffer(req.params.id, req.agentDid!, parsed.data.agentId);
  res.json(job);
});

jobsRouter.post("/:id/cancel", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const job = jobService.cancelJob(req.params.id, req.agentDid!);
  res.json(job);
});

jobsRouter.post("/:id/report-nonperformance", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, (req, res) => {
  const parsed = reportNonPerformanceSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  const job = jobService.reportNonPerformance(req.params.id, req.agentDid!, parsed.data.reason);
  res.json(job);
});
