import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireSignedRequest } from "./signedRequest.js";
import { requireIdempotencyKey } from "./idempotency.js";
import { rateLimitRegistrationByIp, rateLimitWriteByAgent, rateLimitReadByIp } from "./rateLimit.js";
import { ApiError, badRequest } from "./errors.js";
import * as agentService from "./agentService.js";
import * as receiptService from "./receiptService.js";
import * as jobService from "./jobService.js";
import * as verificationService from "./verificationService.js";
import { computeReputation } from "./reputationService.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

// Public reads are meant to be queryable from anywhere, browsers included —
// that's the point of "reputation is public, no account needed" (SPEC.md §5).
// Mutating (signed) endpoints get no CORS headers at all: they're
// server-to-server/agent-to-agent by design, and since auth here is a
// per-request Ed25519 signature (not an ambient browser credential like a
// cookie), CORS wouldn't add real security anyway — a malicious page still
// can't forge a signature it doesn't hold the private key for. Restricting it
// just keeps the surface intentionally narrow until real frontend origins exist.
const PUBLIC_READ_PATHS = [
  "/v1/health",
  "/v1/agents/search",
  "/v1/agents/:id",
  "/v1/agents/:id/protocols",
  "/v1/agents/:id/reputation",
  "/v1/agents/:id/receipts",
  "/v1/jobs/search",
  "/v1/jobs/:id",
  "/v1/receipts/:id",
  "/v1/receipts/:id/verifications",
  "/v1/verifications/:id",
];
// /v1/jobs/:id/offers is GET *and* POST at the same path — a blanket .use()
// would wrongly hand CORS headers to the signed POST too, so it's applied
// inline to just the GET handler below instead.
for (const path of PUBLIC_READ_PATHS) app.use(path, cors({ origin: "*" }));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as never);
  }
  console.error(err);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } }, 500);
});

app.notFound((c) => c.json({ error: { code: "ROUTE_NOT_FOUND", message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

app.get("/v1/health", (c) => c.json({ status: "ok" }));

// ---- Agents ----

app.post("/v1/agents", rateLimitRegistrationByIp, requireSignedRequest, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as { capabilities?: unknown; metadata?: Record<string, unknown> } | undefined;
  if (!body || !Array.isArray(body.capabilities) || body.capabilities.length === 0 || !body.capabilities.every((x) => typeof x === "string")) {
    throw badRequest("VALIDATION_ERROR", "capabilities must be a non-empty array of strings");
  }
  const record = await agentService.registerAgent(c.env, c.get("agentDid")!, { capabilities: body.capabilities as string[], metadata: body.metadata });
  return c.json(record, 201);
});

app.get("/v1/agents/search", rateLimitReadByIp, async (c) => {
  const capability = c.req.query("capability");
  const supports = c.req.query("supports");
  const minReputation = c.req.query("min_reputation") ? Number(c.req.query("min_reputation")) : undefined;

  let results = await agentService.searchAgents(c.env, { capability, supports });
  if (minReputation !== undefined) {
    const withReputation = await Promise.all(results.map(async (a) => ({ a, score: (await computeReputation(c.env, a.id)).trustScore })));
    results = withReputation.filter((x) => x.score >= minReputation).map((x) => x.a);
  }
  return c.json({ agents: results });
});

app.get("/v1/agents/:id", async (c) => c.json(await agentService.getAgent(c.env, c.req.param("id")!)));

app.get("/v1/agents/:id/protocols", async (c) => {
  const agent = await agentService.getAgent(c.env, c.req.param("id")!);
  return c.json({ linked: agent.linked });
});

app.get("/v1/agents/:id/reputation", rateLimitReadByIp, async (c) => c.json(await computeReputation(c.env, c.req.param("id")!)));

app.get("/v1/agents/:id/receipts", async (c) => c.json({ receipts: await receiptService.listByAgent(c.env, c.req.param("id")!) }));

app.post("/v1/agents/:id/link/challenge", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  agentService.requireSelf(c.get("agentDid"), c.req.param("id")!);
  const body = c.get("parsedBody") as { protocol?: string; externalPublicKey?: string; keyType?: string } | undefined;
  if (!body?.protocol || !body?.externalPublicKey || !body?.keyType) {
    throw badRequest("VALIDATION_ERROR", "protocol, externalPublicKey, and keyType are required");
  }
  const challenge = await agentService.requestLinkChallenge(c.env, c.get("agentDid")!, body.protocol, body.externalPublicKey, body.keyType);
  return c.json(challenge, 201);
});

app.post("/v1/agents/:id/link", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  agentService.requireSelf(c.get("agentDid"), c.req.param("id")!);
  const body = c.get("parsedBody") as { protocol?: string; value?: string; challengeId?: string; proofSignature?: string } | undefined;
  if (!body?.protocol || !body?.value) throw badRequest("VALIDATION_ERROR", "protocol and value are required");
  if (body.protocol === "a2a_endpoint") {
    return c.json(await agentService.linkEndpoint(c.env, c.get("agentDid")!, body.protocol, body.value));
  }
  if (!body.challengeId || !body.proofSignature) {
    throw badRequest("CHALLENGE_REQUIRED", "challengeId and proofSignature are required for key-derived identities — call POST /agents/:id/link/challenge first");
  }
  const record = await agentService.completeLink(c.env, c.get("agentDid")!, body.protocol, body.value, body.challengeId, body.proofSignature);
  return c.json(record);
});

// ---- Jobs ----

app.post("/v1/jobs", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as { capability?: string; specHash?: string; budget?: { amount?: string; currency?: string }; expiresAt?: string } | undefined;
  if (!body?.capability || !body?.specHash) throw badRequest("VALIDATION_ERROR", "capability and specHash are required");
  const job = await jobService.postJob(c.env, c.get("agentDid")!, {
    capability: body.capability,
    specHash: body.specHash,
    budget: body.budget,
    expiresAt: body.expiresAt,
  });
  return c.json(job, 201);
});

app.get("/v1/jobs/search", rateLimitReadByIp, async (c) => {
  const capability = c.req.query("capability");
  const status = c.req.query("status");
  return c.json({ jobs: await jobService.searchJobs(c.env, { capability, status }) });
});

app.get("/v1/jobs/:id", async (c) => c.json(await jobService.getJob(c.env, c.req.param("id")!)));

app.post("/v1/jobs/:id/offers", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as { message?: string } | undefined;
  const job = await jobService.submitOffer(c.env, c.req.param("id")!, c.get("agentDid")!, body?.message);
  return c.json(job, 201);
});

app.get("/v1/jobs/:id/offers", cors({ origin: "*" }), async (c) => c.json({ offers: await jobService.listOffers(c.env, c.req.param("id")!) }));

app.post("/v1/jobs/:id/accept", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as { agentId?: string } | undefined;
  if (!body?.agentId) throw badRequest("VALIDATION_ERROR", "agentId is required");
  const job = await jobService.acceptOffer(c.env, c.req.param("id")!, c.get("agentDid")!, body.agentId);
  return c.json(job);
});

app.post("/v1/jobs/:id/cancel", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const job = await jobService.cancelJob(c.env, c.req.param("id")!, c.get("agentDid")!);
  return c.json(job);
});

// ---- Receipts ----

app.post("/v1/receipts", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as (receiptService.CreateDraftInput & Record<string, unknown>) | undefined;
  if (!body?.jobId || !body?.agentAId || !body?.task || !body?.result || !body?.verification || !body?.signature) {
    throw badRequest("VALIDATION_ERROR", "jobId, agentAId, task, result, verification, and signature are required");
  }
  const receipt = await receiptService.createDraft(c.env, c.get("agentDid")!, body);
  return c.json(receipt, 201);
});

app.get("/v1/receipts/:id", async (c) => c.json(await receiptService.getReceipt(c.env, c.req.param("id")!)));

app.get("/v1/receipts/:id/verifications", async (c) => c.json({ verifications: await verificationService.listByReceipt(c.env, c.req.param("id")!) }));

app.post("/v1/receipts/:id/countersign", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as { signature?: string } | undefined;
  if (!body?.signature) throw badRequest("VALIDATION_ERROR", "signature is required");
  const receipt = await receiptService.countersign(c.env, c.req.param("id")!, c.get("agentDid")!, body.signature);
  return c.json(receipt);
});

app.post("/v1/receipts/:id/dispute", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as { reason?: string } | undefined;
  if (!body?.reason) throw badRequest("VALIDATION_ERROR", "reason is required");
  const receipt = await receiptService.openDispute(c.env, c.req.param("id")!, c.get("agentDid")!, body.reason);
  return c.json(receipt);
});

// ---- Verifications (SPEC.md §12) ----

app.post("/v1/verifications", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = c.get("parsedBody") as (verificationService.SubmitVerificationInput & Record<string, unknown>) | undefined;
  if (!body?.receiptId || !body?.verifier || !body?.method || !body?.outputHash || !body?.result || !body?.signature) {
    throw badRequest("VALIDATION_ERROR", "receiptId, verifier, method, outputHash, result, and signature are required");
  }
  const record = await verificationService.submitVerification(c.env, c.get("agentDid")!, body);
  return c.json(record, 201);
});

app.get("/v1/verifications/:id", async (c) => c.json(await verificationService.getVerification(c.env, c.req.param("id")!)));

export default app;
