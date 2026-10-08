import { sha256Hex } from "../crypto/keys.js";

/** Hosted demo counterparty (SPEC.md §14, v0.40). Receipts whose capability
 * starts with this prefix are real, signed and logged, but never count toward
 * reputation or anchoring (§5.2). */
export const DEMO_CAPABILITY_PREFIX = "demo.";
export const DEMO_CAPABILITY = "demo.sha256";

/** The demo task's spec text, derived from its jobId so the task is stateless. */
export const demoSpec = (jobId: string) => `INAM demo task ${jobId}: return the sha256 hex of this line.`;

/** The correct output for a demo task, and the outputHash a receipt must carry. */
export const demoOutput = (jobId: string) => sha256Hex(demoSpec(jobId));
export const demoOutputHash = (jobId: string) => `sha256:${sha256Hex(demoOutput(jobId))}`;
