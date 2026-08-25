import { z } from "zod";

/**
 * Request-body validation schemas — the one other piece of logic every
 * runtime in this repo must agree on precisely, same principle as
 * canonical.ts and receiptContent.ts. Before this file existed, the Node
 * reference server (src/routes/*.ts) validated every mutating request with
 * these exact Zod schemas, while the Cloudflare Worker (worker/src/index.ts)
 * only checked that each required field was *present*, never that its value
 * was actually valid — e.g. a signed POST /v1/verifications with
 * `{ "result": "banana", "score": 999 }` would be rejected by the Node
 * server but accepted by the Worker, silently writing an invalid `result`
 * value into D1 forever. Both runtimes now import from here instead of
 * defining their own copies, so "same request -> same validation -> same
 * error code" is a property of sharing one schema, not of two
 * independently-maintained ones happening to agree today.
 */

export const registerAgentSchema = z.object({
  capabilities: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const linkChallengeSchema = z.object({
  protocol: z.enum(["agentpass_id", "aitp_id", "passport_id"]),
  externalPublicKey: z.string().min(1),
  keyType: z.enum(["ed25519", "p256"]),
});

export const linkSchema = z.object({
  protocol: z.enum(["agentpass_id", "aitp_id", "passport_id", "a2a_endpoint"]),
  value: z.string().min(1),
  challengeId: z.string().min(1).optional(),
  proofSignature: z.string().min(1).optional(),
});

export const postJobSchema = z.object({
  capability: z.string().min(1),
  specHash: z.string().min(1),
  budget: z.object({ amount: z.string().optional(), currency: z.string().optional() }).optional(),
  expiresAt: z.string().optional(),
});

export const offerSchema = z.object({ message: z.string().optional() });

export const acceptOfferSchema = z.object({ agentId: z.string().min(1) });

export const draftReceiptSchema = z.object({
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

export const countersignSchema = z.object({ signature: z.string().min(1) });

export const disputeSchema = z.object({ reason: z.string().min(1) });

export const submitVerificationSchema = z.object({
  receiptId: z.string().min(1),
  verifier: z.string().min(1),
  method: z.enum(["deterministic", "agent_attestation"]),
  outputHash: z.string().min(1),
  result: z.enum(["verified", "rejected"]),
  score: z.number().min(0).max(1).optional(),
  evidenceUri: z.string().optional(),
  signature: z.string().min(1),
});
