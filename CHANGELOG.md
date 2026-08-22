# Changelog

Each package in this repo (Node reference server, Cloudflare Worker, Python SDK) versions independently — they're separate deployables, not a single product release. Protocol-level compatibility is tracked separately: `receiptVersion` in the wire format, and the spec version at the top of `SPEC.md`.

## Protocol specification (`SPEC.md`)

### v0.3 (Draft) — 2026-08-22
- Added the **Job** resource (§3): an optional, discoverable pre-work step — post → offer → accept — ahead of an Execution Receipt. Additive and backward compatible: `jobId` on a receipt remains valid as a plain opaque string with no backing Job at all, exactly as in v0.1/v0.2.
- A receipt whose `jobId` *does* reference a Job now has its parties validated against that job's poster/accepted-worker (`JOB_NOT_ACCEPTED`, `JOB_PARTY_MISMATCH`), and finalizing it automatically completes the job.
- New error codes: `JOB_NOT_FOUND`, `JOB_NOT_OPEN`, `JOB_NOT_ACCEPTED`, `JOB_NOT_CANCELLABLE`, `JOB_PARTY_MISMATCH`, `NOT_POSTER`, `OFFER_NOT_FOUND`, `OFFER_ALREADY_SUBMITTED`.
- Sections renumbered (Job inserted as §3; everything from the old §3 onward shifts by one) — no change to any existing field name or wire format.
- Implemented and verified in all three runtimes (Node, Cloudflare Workers, and both SDKs), including against the live deployment.

### v0.2 (Draft) — 2026-08-22
- Normative language pass: RFC 2119 (MUST/SHOULD/MAY) keywords applied throughout, distinguishing hard conformance requirements (identity self-certification, receipt signature verification, atomic lifecycle transitions, endpoint/signing requirements) from reference-implementation-specific detail (the exact reputation formula, which a registry MAY compute differently as long as the response shape stays auditable).
- Documented the rate limiting and CORS policies, the `RATE_LIMITED` error code, and the second live Cloudflare Workers deployment with its custom domain (`api.inamprotocol.org`).
- No wire-format break — `receiptVersion` stays `"1.0"`.

### v0.1 (Draft) — 2026-08-21
- Initial specification: positioning, INAM ID (`did:key`), Execution Receipt schema/lifecycle, reputation model, REST API, request signing, SDK architecture requirements, explicit non-goals, relationship to other protocols.

## Node reference server & Cloudflare Worker

### 0.3.0 — 2026-08-22
- Added the Job resource end-to-end in both runtimes: `src/services/jobService.ts` (Node) and `worker/src/jobService.ts` (Worker, D1-backed — offers live in their own `job_offers` table specifically to avoid a read-modify-write race on a shared JSON blob when two agents offer concurrently), wired into the receipt lifecycle (job auto-completes on receipt finalize; parties validated against the job when one is referenced).
- Tests: `tests/jobFlow.test.ts` (service layer) + `scripts/job-smoke-test.ts` (Node, real HTTP) + `worker/tests/api.test.ts` additions (Worker, including a concurrent-accept race regression test) + `scripts/worker-smoke-test.ts` additions, run against both local and the live deployment.
- Also fixed an unrelated flaky test (`worker/tests/api.test.ts`'s rate-limit test used a hardcoded fixed IP that could pick up residual state from local Miniflare's on-disk persistence across separate test runs).

### 0.2.0 — 2026-08-22 (Phase 1 hardening)
- Fixed a TOCTOU race in receipt countersign/dispute on D1 (compare-and-swap via `UPDATE ... WHERE status=X` + `meta.changes` check).
- Fixed a race in agent registration (plain `INSERT` + UNIQUE-violation catch, replacing check-then-upsert).
- Added rate limiting to both runtimes (IP-scoped registration, DID-scoped writes, IP-scoped expensive reads).
- Decided and implemented a CORS policy: public reads open, signed writes unrestricted-by-CORS (auth is per-request signature, not an ambient credential).
- Enforced D1 foreign keys (`PRAGMA foreign_keys = ON`, batched with receipt inserts).
- Fixed an O(receipts) reputation-computation cost-amplification issue found during a security review (memoize `baseTrust` per counterparty).
- Added a real assertion-based Worker test suite (`@cloudflare/vitest-plugin`), including a dedicated regression test for the race-condition fix.
- Added `openapi.yaml`.

### 0.1.0 — 2026-08-21
- Initial reference implementation: `did:key` identity, content-addressed Execution Receipts (draft → countersign → finalized → disputed), sybil-resistance-informed reputation engine, `InamClient` SDK, Cloudflare Workers deployment (D1 + KV).

## Python SDK (`sdk-python`)

### 0.2.0 — 2026-08-22
- Added Job resource methods (`post_job`, `get_job`, `search_jobs`, `submit_offer`, `list_offers`, `accept_offer`, `cancel_job`) — `sdk-python/examples/job_demo.py` demonstrates the full flow, verified against both the local Node server and the live Cloudflare deployment.
- Fixed a latent bug in `register_agent` (and applied the same fix to the new `submit_offer`): an omitted optional field was being sent as JSON `null` instead of leaving the key out entirely. Python's `json.dumps` serializes `None` as `null`, unlike JS's `JSON.stringify`, which drops `undefined`-valued keys — the server's zod schemas treat these fields as optional-if-absent, not nullable, so a literal `null` failed validation.

### 0.1.1 — 2026-08-22
- Set an honest custom User-Agent (`inamprotocol-python-sdk/0.1.0`) — Cloudflare's bot protection on `*.workers.dev` was flagging the default `Python-urllib/x.y` User-Agent.

### 0.1.0 — 2026-08-21
- Initial parity SDK: `did:key`, canonical JSON, Ed25519 signing, `InamClient`. Cross-language correctness verified against fixed TypeScript-generated test vectors and a live two-language demo.
