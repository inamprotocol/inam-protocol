import { jobs, agents } from "../storage/db.js";
import { badRequest, conflict, forbidden, notFound } from "../middleware/errors.js";
import type { JobRecord } from "../types.js";

export interface PostJobInput {
  capability: string;
  specHash: string;
  budget?: { amount?: string; currency?: string };
  expiresAt?: string;
}

function generateJobId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function postJob(callerDid: string, input: PostJobInput): JobRecord {
  if (!agents.has(callerDid)) throw notFound("AGENT_NOT_FOUND", "Job poster must be a registered agent");
  const job: JobRecord = {
    jobId: generateJobId(),
    postedBy: callerDid,
    capability: input.capability,
    specHash: input.specHash,
    budget: input.budget,
    status: "open",
    offers: [],
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresAt,
  };
  jobs.set(job.jobId, job);
  return job;
}

export function getJob(id: string): JobRecord {
  const job = jobs.get(id);
  if (!job) throw notFound("JOB_NOT_FOUND", `No job with id ${id}`);
  return job;
}

export interface JobSearchQuery {
  capability?: string;
  status?: string;
}

export function searchJobs(query: JobSearchQuery): JobRecord[] {
  return jobs.all().filter((j) => {
    if (query.capability && j.capability !== query.capability) return false;
    if (query.status && j.status !== query.status) return false;
    return true;
  });
}

export function listByPoster(agentId: string): JobRecord[] {
  return jobs.all().filter((j) => j.postedBy === agentId || j.acceptedAgentId === agentId);
}

export function submitOffer(jobId: string, callerDid: string, message?: string): JobRecord {
  const job = getJob(jobId);
  if (job.status !== "open") throw conflict("JOB_NOT_OPEN", "Offers can only be submitted on an open job");
  if (job.postedBy === callerDid) throw badRequest("SELF_DEALING", "A job's poster cannot offer to work on their own job");
  if (!agents.has(callerDid)) throw notFound("AGENT_NOT_FOUND", "Offering agent must be registered");
  if (job.offers.some((o) => o.agentId === callerDid)) {
    throw conflict("OFFER_ALREADY_SUBMITTED", "This agent has already made an offer on this job");
  }
  const updated: JobRecord = { ...job, offers: [...job.offers, { agentId: callerDid, message, createdAt: new Date().toISOString() }] };
  jobs.set(jobId, updated);
  return updated;
}

export function acceptOffer(jobId: string, callerDid: string, agentId: string): JobRecord {
  const job = getJob(jobId);
  if (callerDid !== job.postedBy) throw forbidden("NOT_POSTER", "Only the job's poster may accept an offer");
  if (job.status !== "open") throw conflict("JOB_NOT_OPEN", "Only an open job can have an offer accepted");
  if (!job.offers.some((o) => o.agentId === agentId)) throw badRequest("OFFER_NOT_FOUND", "No such offer on this job");
  const updated: JobRecord = { ...job, status: "accepted", acceptedAgentId: agentId };
  jobs.set(jobId, updated);
  return updated;
}

export function cancelJob(jobId: string, callerDid: string): JobRecord {
  const job = getJob(jobId);
  if (callerDid !== job.postedBy) throw forbidden("NOT_POSTER", "Only the job's poster may cancel it");
  if (job.status === "completed" || job.status === "cancelled") {
    throw conflict("JOB_NOT_CANCELLABLE", `A ${job.status} job cannot be cancelled`);
  }
  const updated: JobRecord = { ...job, status: "cancelled" };
  jobs.set(jobId, updated);
  return updated;
}

/** Called by receiptService once a receipt referencing this job is finalized. */
export function markCompletedByReceipt(jobId: string, receiptId: string): void {
  const job = jobs.get(jobId);
  if (!job) return; // jobId with no backing Job resource — receipts work fine without one (see SPEC.md §3)
  jobs.set(jobId, { ...job, status: "completed", receiptId });
}

/**
 * If a receipt's jobId references a real Job resource, its parties MUST match
 * that job's poster and accepted worker — otherwise an unrelated pair of
 * agents could "complete" someone else's job by coincidentally reusing its id.
 * Returns silently if no Job resource exists for this jobId (receipts remain
 * valid without one — Job is an additive, optional resource).
 */
export function assertReceiptMatchesJob(jobId: string, agentAId: string, agentBId: string): void {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.status !== "accepted") {
    throw conflict("JOB_NOT_ACCEPTED", "A receipt can only reference a job once an offer has been accepted on it");
  }
  if (job.postedBy !== agentAId || job.acceptedAgentId !== agentBId) {
    throw forbidden("JOB_PARTY_MISMATCH", "The receipt's parties do not match this job's poster and accepted worker");
  }
}
