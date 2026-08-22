import path from "node:path";
import { JsonStore } from "./jsonStore.js";
import { config } from "../config.js";
import type { AgentRecord, ExecutionReceipt, JobRecord } from "../types.js";

export const agents = new JsonStore<AgentRecord>(path.join(config.dataDir, "agents.json"));
export const receipts = new JsonStore<ExecutionReceipt>(path.join(config.dataDir, "receipts.json"));
export const jobs = new JsonStore<JobRecord>(path.join(config.dataDir, "jobs.json"));

/** In-memory idempotency cache: (agentDid:key) -> cached response body + status. Resets on restart. */
export const idempotencyCache = new Map<string, { status: number; body: unknown }>();
