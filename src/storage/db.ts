import path from "node:path";
import { JsonStore } from "./jsonStore.js";
import { config } from "../config.js";
import type { AgentRecord, ExecutionReceipt, JobRecord, LinkChallengeRecord, VerificationRecord } from "../types.js";

export const agents = new JsonStore<AgentRecord>(path.join(config.dataDir, "agents.json"));
export const receipts = new JsonStore<ExecutionReceipt>(path.join(config.dataDir, "receipts.json"));
export const jobs = new JsonStore<JobRecord>(path.join(config.dataDir, "jobs.json"));
export const verifications = new JsonStore<VerificationRecord>(path.join(config.dataDir, "verifications.json"));

/** In-memory idempotency cache: (agentDid:key) -> cached response body + status. Resets on restart. */
export const idempotencyCache = new Map<string, { status: number; body: unknown }>();

/** In-memory, short-lived (60s) link challenges — not persisted to disk on
 * purpose, same reasoning as the idempotency cache above. */
export const linkChallenges = new Map<string, LinkChallengeRecord>();
