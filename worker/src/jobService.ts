import * as db from "./db.js";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";
import * as transparencyService from "./transparencyService.js";
import type { Env, JobRecord } from "./types.js";

// Same value as receiptService.ts's DISPUTE_WINDOW_HOURS (kept as separate
// constants, not shared, to avoid a circular import — receiptService.ts
// already imports jobService.ts). Reused here as the non-performance grace
// window: the worker acted in good faith by accepting, so no reporting
// before it's had at least as long to deliver as a dispute gets to resolve.
const NON_PERFORMANCE_GRACE_HOURS = 72;

export interface PostJobInput {
  capability: string;
  specHash: string;
  budget?: { amount?: string; currency?: string };
  expiresAt?: string;
}

// Math.random() isn't cryptographically random -- an external review flagged
// job ids as guessable. randomUUID() closes it; job ids were never a secret
// (jobs are discoverable by design, SPEC.md §3), but predictability has no
// upside either.
function generateJobId(): string {
  return `job_${crypto.randomUUID()}`;
}

/** Lazy expiry (SPEC.md §3.2): a job past its `expiresAt` accepts no offers
 *  and no acceptance. Status isn't auto-transitioned (no sweeper — §10),
 *  it's just closed at the gates. */
function assertNotExpired(job: JobRecord): void {
  if (job.expiresAt && new Date(job.expiresAt).getTime() < Date.now()) {
    throw conflict("JOB_EXPIRED", "This job's expiresAt has passed — it accepts no further offers or acceptances");
  }
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
  assertNotExpired(job);
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
  assertNotExpired(job);
  if (!(await db.offerExists(env, jobId, agentId))) throw badRequest("OFFER_NOT_FOUND", "No such offer on this job");
  const applied = await db.acceptJobIfOpen(env, jobId, agentId, new Date().toISOString());
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

/**
 * A one-sided "the accepted worker never delivered" report (SPEC.md §3.3,
 * v0.25). See src/services/jobService.ts's reportNonPerformance (Node
 * reference) for the full rationale — this mirrors it.
 */
export async function reportNonPerformance(env: Env, jobId: string, callerDid: string, reason?: string): Promise<JobRecord> {
  const job = await getJob(env, jobId);
  if (callerDid !== job.postedBy) throw forbidden("NOT_POSTER", "Only the job's poster may report non-performance");
  if (job.status !== "accepted") throw conflict("JOB_NOT_REPORTABLE", "Only an accepted job can be reported as non-performed");
  const acceptedMs = new Date(job.acceptedAt!).getTime();
  if (Date.now() - acceptedMs < NON_PERFORMANCE_GRACE_HOURS * 3600_000) {
    throw conflict("TOO_EARLY_TO_REPORT", `Non-performance can only be reported ${NON_PERFORMANCE_GRACE_HOURS}h after acceptance`);
  }
  const applied = await db.reportNonPerformanceIfAccepted(env, jobId, new Date().toISOString(), reason);
  if (!applied) throw conflict("JOB_NOT_REPORTABLE", "Only an accepted job can be reported as non-performed");
  const updated = await getJob(env, jobId);
  await transparencyService.appendEntry(env, "nonperformance_reported", jobId, updated.nonPerformance);
  return updated;
}

/** Every job the given agent was the accepted worker on and was later
 *  reported as non-performed. Used only by reputationService. */
export async function listNonPerformanceAgainst(env: Env, agentId: string): Promise<JobRecord[]> {
  return db.nonPerformanceJobsForAgent(env, agentId);
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
