import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ZodType } from "zod";
import { requireSignedRequest } from "./signedRequest.js";
import { requireIdempotencyKey } from "./idempotency.js";
import { rateLimitRegistrationByIp, rateLimitWriteByAgent, rateLimitReadByIp } from "./rateLimit.js";
import { ApiError, badRequest } from "./errors.js";
import * as agentService from "./agentService.js";
import * as receiptService from "./receiptService.js";
import * as jobService from "./jobService.js";
import * as verificationService from "./verificationService.js";
import { computeReputation } from "./reputationService.js";
import { badgeDataForReputation, badgeDataToJson, notFoundBadgeData, renderBadgeSvg } from "./badgeService.js";
import {
  registerAgentSchema,
  setVerifierStatusSchema,
  linkChallengeSchema,
  linkSchema,
  postJobSchema,
  offerSchema,
  acceptOfferSchema,
  draftReceiptSchema,
  countersignSchema,
  disputeSchema,
  submitVerificationSchema,
} from "../../sdk-js/src/core/schemas.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

// Validates the already-JSON-parsed request body against one of the shared
// schemas from sdk-js/src/core/schemas.ts and returns the typed, parsed
// value, or throws the same VALIDATION_ERROR the Node reference server
// throws for the identical bad input (src/routes/*.ts uses
// `schema.safeParse` + `badRequest("VALIDATION_ERROR", ...)` directly;
// mirrored here rather than shared as a helper function across runtimes
// since badRequest/ApiError are themselves per-runtime, same as
// reputationService.ts's duplication).
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw badRequest("VALIDATION_ERROR", parsed.error.message);
  return parsed.data;
}

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
  "/v1/agents/:id/badge.svg",
  "/v1/agents/:id/badge.json",
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
  const body = parseBody(registerAgentSchema, c.get("parsedBody"));
  const record = await agentService.registerAgent(c.env, c.get("agentDid")!, body);
  return c.json(record, 201);
});

// Operator-only: grants or revokes an agent's verifier status (SPEC.md
// §12.3). Not restricted to the target agent itself (unlike the link/link-
// challenge routes' requireSelf) -- the whole point is that only the
// registry's configured operator identity may call this, for any agent.
app.post("/v1/agents/:id/verifier-status", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(setVerifierStatusSchema, c.get("parsedBody"));
  const record = await agentService.setVerifierStatus(c.env, c.get("agentDid")!, c.req.param("id")!, body.authorized);
  return c.json(record);
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

// Read-only, unsigned, public badge rendering — a sibling of /reputation, not
// a modification of it. Reuses computeReputation() directly rather than
// re-implementing scoring; badgeService.ts only maps its output to a small
// fixed set of colors/labels. AGENT_NOT_FOUND is caught here so an unknown
// did:key still renders a valid badge image instead of a raw JSON error /
// broken <img>.
async function badgeDataForAgent(env: AppEnv["Bindings"], id: string) {
  try {
    return badgeDataForReputation(await computeReputation(env, id));
  } catch (err) {
    if (err instanceof ApiError && err.code === "AGENT_NOT_FOUND") return notFoundBadgeData();
    throw err;
  }
}

app.get("/v1/agents/:id/badge.svg", rateLimitReadByIp, async (c) => {
  const data = await badgeDataForAgent(c.env, c.req.param("id")!);
  // Short-lived but cacheable: badges get embedded in other projects'
  // READMEs and hit repeatedly by viewers/crawlers, but are meant to reflect
  // live reputation, so this shouldn't go stale for long either.
  return c.body(renderBadgeSvg(data), 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "public, max-age=120",
  });
});

app.get("/v1/agents/:id/badge.json", rateLimitReadByIp, async (c) => {
  const data = await badgeDataForAgent(c.env, c.req.param("id")!);
  c.header("Cache-Control", "public, max-age=120");
  return c.json(badgeDataToJson(data));
});

app.get("/v1/agents/:id/receipts", async (c) => c.json({ receipts: await receiptService.listByAgent(c.env, c.req.param("id")!) }));

app.post("/v1/agents/:id/link/challenge", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  agentService.requireSelf(c.get("agentDid"), c.req.param("id")!);
  const body = parseBody(linkChallengeSchema, c.get("parsedBody"));
  const challenge = await agentService.requestLinkChallenge(c.env, c.get("agentDid")!, body.protocol, body.externalPublicKey, body.keyType);
  return c.json(challenge, 201);
});

app.post("/v1/agents/:id/link", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  agentService.requireSelf(c.get("agentDid"), c.req.param("id")!);
  const body = parseBody(linkSchema, c.get("parsedBody"));
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
  const body = parseBody(postJobSchema, c.get("parsedBody"));
  const job = await jobService.postJob(c.env, c.get("agentDid")!, body);
  return c.json(job, 201);
});

app.get("/v1/jobs/search", rateLimitReadByIp, async (c) => {
  const capability = c.req.query("capability");
  const status = c.req.query("status");
  return c.json({ jobs: await jobService.searchJobs(c.env, { capability, status }) });
});

app.get("/v1/jobs/:id", async (c) => c.json(await jobService.getJob(c.env, c.req.param("id")!)));

app.post("/v1/jobs/:id/offers", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(offerSchema, c.get("parsedBody") ?? {});
  const job = await jobService.submitOffer(c.env, c.req.param("id")!, c.get("agentDid")!, body.message);
  return c.json(job, 201);
});

app.get("/v1/jobs/:id/offers", cors({ origin: "*" }), async (c) => c.json({ offers: await jobService.listOffers(c.env, c.req.param("id")!) }));

app.post("/v1/jobs/:id/accept", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(acceptOfferSchema, c.get("parsedBody"));
  const job = await jobService.acceptOffer(c.env, c.req.param("id")!, c.get("agentDid")!, body.agentId);
  return c.json(job);
});

app.post("/v1/jobs/:id/cancel", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const job = await jobService.cancelJob(c.env, c.req.param("id")!, c.get("agentDid")!);
  return c.json(job);
});

// ---- Receipts ----

app.post("/v1/receipts", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(draftReceiptSchema, c.get("parsedBody"));
  const receipt = await receiptService.createDraft(c.env, c.get("agentDid")!, body);
  return c.json(receipt, 201);
});

app.get("/v1/receipts/:id", async (c) => c.json(await receiptService.getReceipt(c.env, c.req.param("id")!)));

app.get("/v1/receipts/:id/verifications", async (c) => c.json({ verifications: await verificationService.listByReceipt(c.env, c.req.param("id")!) }));

app.post("/v1/receipts/:id/countersign", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(countersignSchema, c.get("parsedBody"));
  const receipt = await receiptService.countersign(c.env, c.req.param("id")!, c.get("agentDid")!, body.signature);
  return c.json(receipt);
});

app.post("/v1/receipts/:id/dispute", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(disputeSchema, c.get("parsedBody"));
  const receipt = await receiptService.openDispute(c.env, c.req.param("id")!, c.get("agentDid")!, body.reason);
  return c.json(receipt);
});

// ---- Verifications (SPEC.md §12) ----

app.post("/v1/verifications", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(submitVerificationSchema, c.get("parsedBody"));
  const record = await verificationService.submitVerification(c.env, c.get("agentDid")!, body);
  return c.json(record, 201);
});

app.get("/v1/verifications/:id", async (c) => c.json(await verificationService.getVerification(c.env, c.req.param("id")!)));

export default app;
