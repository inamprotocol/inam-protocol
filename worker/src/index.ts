import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { ZodType } from "zod";
import { requireSignedRequest, optionalSignedRequest } from "./signedRequest.js";
import { requireIdempotencyKey } from "./idempotency.js";
import { rateLimitRegistrationByIp, rateLimitWriteByAgent, rateLimitReadByIp } from "./rateLimit.js";
import { ApiError, badRequest, forbidden } from "./errors.js";
import * as agentService from "./agentService.js";
import * as receiptService from "./receiptService.js";
import * as jobService from "./jobService.js";
import * as verificationService from "./verificationService.js";
import { computeReputation } from "./reputationService.js";
import * as transparencyService from "./transparencyService.js";
import { badgeDataForReputation, badgeDataToJson, notFoundBadgeData, renderBadgeSvg } from "./badgeService.js";
import {
  registerAgentSchema,
  setVerifierStatusSchema,
  revokeAgentSchema,
  linkChallengeSchema,
  linkSchema,
  postJobSchema,
  offerSchema,
  acceptOfferSchema,
  reportNonPerformanceSchema,
  draftReceiptSchema,
  countersignSchema,
  disputeSchema,
  resolveDisputeSchema,
  submitVerificationSchema,
} from "../../sdk-js/src/core/schemas.js";
import { parsePageParams, paginate } from "../../sdk-js/src/core/pagination.js";
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
  const includeRevoked = c.req.query("include_revoked") === "true";

  let results = await agentService.searchAgents(c.env, { capability, supports, includeRevoked });
  // SPEC.md §2 (v0.33): self-declared demo/test agents stay out of discovery
  // unless asked for, so they don't read as real network activity.
  if (c.req.query("include_demo") !== "true") results = results.filter((a) => a.metadata?.demo !== true);
  if (minReputation !== undefined) {
    const withReputation = await Promise.all(results.map(async (a) => ({ a, score: (await computeReputation(c.env, a.id)).trustScore })));
    results = withReputation.filter((x) => x.score >= minReputation).map((x) => x.a);
  }
  const { page, hasMore } = paginate(results, parsePageParams(c.req.query("limit"), c.req.query("offset")));
  return c.json({ agents: page, hasMore });
});

app.get("/v1/agents/:id", async (c) => c.json(await agentService.getAgent(c.env, c.req.param("id")!)));

app.get("/v1/agents/:id/protocols", async (c) => {
  const agent = await agentService.getAgent(c.env, c.req.param("id")!);
  return c.json({ linked: agent.linked, linkedProof: agent.linkedProof });
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

// SPEC.md §4.4 (v0.19): a `participants_only` receipt is silently omitted
// for a caller that isn't a party to it or a verifier who's attested it —
// filtering, not an error, same reasoning as the Node reference server's
// identical route (src/routes/agents.ts).
app.get("/v1/agents/:id/receipts", optionalSignedRequest, async (c) => {
  const callerDid = c.get("agentDid");
  const all = await receiptService.listByAgent(c.env, c.req.param("id")!);
  const visible = await Promise.all(
    all.map(async (r) => {
      const isVerifier = r.visibility === "participants_only" && !!callerDid && (await verificationService.listByReceipt(c.env, r.receiptId)).some((v) => v.verifier === callerDid);
      return receiptService.isReceiptVisible(r, callerDid, isVerifier) ? r : null;
    }),
  );
  return c.json({ receipts: visible.filter((r): r is NonNullable<typeof r> => r !== null) });
});

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

// The agent retires its own INAM ID (SPEC.md §2.2) — one-way. requireSelf
// gates it to the ID being revoked; requireSignedRequest already rejects a
// call from an *already* revoked ID.
app.post("/v1/agents/:id/revoke", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  agentService.requireSelf(c.get("agentDid"), c.req.param("id")!);
  const body = parseBody(revokeAgentSchema, c.get("parsedBody"));
  return c.json(await agentService.revokeAgent(c.env, c.get("agentDid")!, body.reason));
});

// ---- Jobs ----

app.post("/v1/jobs", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(postJobSchema, c.get("parsedBody"));
  const job = await jobService.postJob(c.env, c.get("agentDid")!, body);
  return c.json(job, 201);
});

// An external review found GET /jobs/:id and /jobs/search exposed the full
// job record (postedBy, acceptedAgentId, budget, ...) unconditionally, even
// when the job's linked receipt is `participants_only` -- defeating that
// receipt's own visibility setting entirely, since the same parties/amounts
// are readable right off the job. Mirrors receiptService.isReceiptVisible
// (same participants-or-verifier check) against the job's linked receipt;
// same reasoning as the Node reference server's identical route
// (src/routes/jobs.ts).
async function isJobVisible(c: Context<AppEnv>, job: Awaited<ReturnType<typeof jobService.getJob>>, callerDid: string | undefined): Promise<boolean> {
  if (!job.receiptId) return true;
  let receipt;
  try {
    receipt = await receiptService.getReceipt(c.env, job.receiptId);
  } catch {
    return true;
  }
  const isVerifier = await callerIsVerifierOf(c, receipt.receiptId, callerDid);
  return receiptService.isReceiptVisible(receipt, callerDid, isVerifier);
}

app.get("/v1/jobs/search", optionalSignedRequest, rateLimitReadByIp, async (c) => {
  const capability = c.req.query("capability");
  const status = c.req.query("status");
  const callerDid = c.get("agentDid");
  const all = await jobService.searchJobs(c.env, { capability, status });
  const visibleResults = await Promise.all(all.map(async (j) => ((await isJobVisible(c, j, callerDid)) ? j : null)));
  const visible = visibleResults.filter((j): j is NonNullable<typeof j> => j !== null);
  const { page, hasMore } = paginate(visible, parsePageParams(c.req.query("limit"), c.req.query("offset")));
  return c.json({ jobs: page, hasMore });
});

app.get("/v1/jobs/:id", optionalSignedRequest, async (c) => {
  const job = await jobService.getJob(c.env, c.req.param("id")!);
  if (!(await isJobVisible(c, job, c.get("agentDid")))) {
    throw forbidden("JOB_NOT_VISIBLE", "This job's receipt is participants_only; the caller is not a party to it or a verifier who has attested it");
  }
  return c.json(job);
});

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

app.post("/v1/jobs/:id/report-nonperformance", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(reportNonPerformanceSchema, c.get("parsedBody"));
  const job = await jobService.reportNonPerformance(c.env, c.req.param("id")!, c.get("agentDid")!, body.reason);
  return c.json(job);
});

// ---- Receipts ----

app.post("/v1/receipts", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(draftReceiptSchema, c.get("parsedBody"));
  const receipt = await receiptService.createDraft(c.env, c.get("agentDid")!, body);
  return c.json(receipt, 201);
});

// SPEC.md §4.4 (v0.19), same reasoning as the Node reference server's
// identical route (src/routes/receipts.ts).
async function callerIsVerifierOf(c: Context<AppEnv>, receiptId: string, callerDid: string | undefined): Promise<boolean> {
  if (!callerDid) return false;
  return (await verificationService.listByReceipt(c.env, receiptId)).some((v) => v.verifier === callerDid);
}

app.get("/v1/receipts/:id", optionalSignedRequest, async (c) => {
  const receipt = await receiptService.getReceipt(c.env, c.req.param("id")!);
  receiptService.assertReceiptVisible(receipt, c.get("agentDid"), await callerIsVerifierOf(c, receipt.receiptId, c.get("agentDid")));
  return c.json(receipt);
});

app.get("/v1/receipts/:id/verifications", optionalSignedRequest, async (c) => {
  const receipt = await receiptService.getReceipt(c.env, c.req.param("id")!);
  const records = await verificationService.listByReceipt(c.env, c.req.param("id")!);
  const callerDid = c.get("agentDid");
  const isVerifier = callerDid ? records.some((v) => v.verifier === callerDid) : false;
  receiptService.assertReceiptVisible(receipt, callerDid, isVerifier);
  return c.json({ verifications: records });
});

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

// The dispute's opener withdraws it (SPEC.md §4.3): disputed -> finalized.
app.post("/v1/receipts/:id/dispute/resolve", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(resolveDisputeSchema, c.get("parsedBody") ?? {});
  return c.json(await receiptService.resolveDispute(c.env, c.req.param("id")!, c.get("agentDid")!, body.note));
});

// ---- Verifications (SPEC.md §12) ----

app.post("/v1/verifications", requireSignedRequest, rateLimitWriteByAgent, requireIdempotencyKey, async (c) => {
  const body = parseBody(submitVerificationSchema, c.get("parsedBody"));
  const record = await verificationService.submitVerification(c.env, c.get("agentDid")!, body);
  return c.json(record, 201);
});

app.get("/v1/verifications/:id", async (c) => c.json(await verificationService.getVerification(c.env, c.req.param("id")!)));

app.get("/v1/transparency/sth", rateLimitReadByIp, async (c) => c.json(await transparencyService.getSTH(c.env)));

app.get("/v1/transparency/entries", rateLimitReadByIp, async (c) => {
  const { limit, offset } = parsePageParams(c.req.query("limit"), c.req.query("offset"));
  const { entries, total } = await transparencyService.getEntries(c.env, limit, offset);
  return c.json({ entries, hasMore: offset + limit < total });
});

function parseIntParam(raw: string | undefined, name: string): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) {
    throw badRequest("VALIDATION_ERROR", `${name} must be an integer`);
  }
  return n;
}

app.get("/v1/transparency/proof/inclusion", rateLimitReadByIp, async (c) => {
  const leafIndex = parseIntParam(c.req.query("leafIndex"), "leafIndex");
  const rawTreeSize = c.req.query("treeSize");
  const treeSize = rawTreeSize !== undefined ? parseIntParam(rawTreeSize, "treeSize") : undefined;
  return c.json(await transparencyService.getInclusionProof(c.env, leafIndex, treeSize));
});

app.get("/v1/transparency/proof/consistency", rateLimitReadByIp, async (c) => {
  const first = parseIntParam(c.req.query("first"), "first");
  const rawSecond = c.req.query("second");
  const second = rawSecond !== undefined ? parseIntParam(rawSecond, "second") : undefined;
  return c.json(await transparencyService.getConsistencyProof(c.env, first, second));
});

export default app;
