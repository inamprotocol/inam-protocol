import * as db from "./db.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import type { Env, JobRecord } from "./types.js";

export interface PostJobInput {
  capability: string;
  specHash: string;
  budget?: { amount?: string; currency?: string };
  expiresAt?: string;
}

function generateJobId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function postJob(env: Env, callerDid: string, input: PostJobInput): Promise<JobRecord> {
  if (!(await db.getAgent(env, callerDid))) throw notFound("AGENT_NOT_FOUND", "Job poster must be a registered agent");
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
  await db.insertJob(env, job);
  return job;
}

export async function getJob(env: Env, id: string): Promise<JobRecord> {
  const job = await db.getJob(env, id);
  if (!job) throw notFound("JOB_NOT_FOUND", `No job with id ${id}`);
  return job;
}

export async function searchJobs(env: Env, query: db.JobSearchQuery): Promise<JobRecord[]> {
  return db.searchJobs(env, query);
}

export async function submitOffer(env: Env, jobId: string, callerDid: string, message?: string): Promise<JobRecord> {
  const job = await getJob(env, jobId);
  if (job.status !== "open") throw conflict("JOB_NOT_OPEN", "Offers can only be submitted on an open job");
  if (job.postedBy === callerDid) throw badRequest("SELF_DEALING", "A job's poster cannot offer to work on their own job");
  if (!(await db.getAgent(env, callerDid))) throw notFound("AGENT_NOT_FOUND", "Offering agent must be registered");
  try {
    await db.insertOffer(env, jobId, { agentId: callerDid, message, createdAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof db.OfferAlreadyExistsError) {
      throw conflict("OFFER_ALREADY_SUBMITTED", "This agent has already made an offer on this job");
    }
    throw err;
  }
  return getJob(env, jobId);
}

export async function listOffers(env: Env, jobId: string) {
  await getJob(env, jobId); // 404s if the job doesn't exist
  return db.getOffers(env, jobId);
}

export async function acceptOffer(env: Env, jobId: string, callerDid: string, agentId: string): Promise<JobRecord> {
  const job = await getJob(env, jobId);
  if (callerDid !== job.postedBy) throw forbidden("NOT_POSTER", "Only the job's poster may accept an offer");
  if (!(await db.offerExists(env, jobId, agentId))) throw badRequest("OFFER_NOT_FOUND", "No such offer on this job");
  const applied = await db.acceptJobIfOpen(env, jobId, agentId);
  if (!applied) throw conflict("JOB_NOT_OPEN", "Only an open job can have an offer accepted");
  return getJob(env, jobId);
}

export async function cancelJob(env: Env, jobId: string, callerDid: string): Promise<JobRecord> {
  const job = await getJob(env, jobId);
  if (callerDid !== job.postedBy) throw forbidden("NOT_POSTER", "Only the job's poster may cancel it");
  const applied = await db.cancelJobIfCancellable(env, jobId);
  if (!applied) throw conflict("JOB_NOT_CANCELLABLE", `A ${job.status} job cannot be cancelled`);
  return getJob(env, jobId);
}

/** Called by receiptService once a receipt referencing this job is finalized. */
export async function markCompletedByReceipt(env: Env, jobId: string, receiptId: string): Promise<void> {
  await db.completeJobIfAccepted(env, jobId, receiptId);
}

/**
 * If a receipt's jobId references a real Job resource, its parties MUST match
 * that job's poster and accepted worker. Returns silently if no Job resource
 * exists for this jobId — receipts remain valid without one.
 */
export async function assertReceiptMatchesJob(env: Env, jobId: string, agentAId: string, agentBId: string): Promise<void> {
  const job = await db.getJob(env, jobId);
  if (!job) return;
  if (job.status !== "accepted") {
    throw conflict("JOB_NOT_ACCEPTED", "A receipt can only reference a job once an offer has been accepted on it");
  }
  if (job.postedBy !== agentAId || job.acceptedAgentId !== agentBId) {
    throw forbidden("JOB_PARTY_MISMATCH", "The receipt's parties do not match this job's poster and accepted worker");
  }
}
