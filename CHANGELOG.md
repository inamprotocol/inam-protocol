# Changelog

Each package in this repo (Node reference server, Cloudflare Worker, Python SDK) versions independently — they're separate deployables, not a single product release. Protocol-level compatibility is tracked separately: `receiptVersion` in the wire format, and the spec version at the top of `SPEC.md`.

## Protocol specification (`SPEC.md`)

### v0.4 (Draft) — 2026-08-22
- Added external-identity **link challenges** (§2.1): linking `agentpass_id` / `aitp_id` / `passport_id` now requires proving control of the claimed external public key via a single-use, ~60s signed challenge (Ed25519 or P-256) before a registry stores the link — closing the "self-signed unchecked claim" gap explicitly called out since v0.1. `a2a_endpoint` is unaffected (it's a service URL, not a key-derived identity).
- Wire format aligns with ATTP (`draft-sharif-attp-00`, the trust-transport protocol AgentPass is built on): 32 random bytes hex-encoded, ECDSA-P256 or Ed25519, 64-byte compact `r‖s` signature encoding, canonical low-S required. Documented as best-effort alignment, not a certified ATTP conformance claim.
- New error codes: `UNSUPPORTED_KEY_TYPE`, `CHALLENGE_NOT_FOUND`, `CHALLENGE_EXPIRED`, `CHALLENGE_ALREADY_USED`, `CHALLENGE_MISMATCH`, `CHALLENGE_REQUIRED`, `PROOF_INVALID`.
- Explicitly still out of scope: live cross-registry resolution (confirming the linked key is still the one AgentPass/AITP/Passport Alliance currently recognize as authoritative) and ATTP conformance certification.
- Implemented and verified in all three runtimes (Node, Cloudflare Workers, both SDKs), including a real Ed25519 + P-256 cross-language interop check between the TypeScript and Python SDKs.

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

## TypeScript/JavaScript SDK (`sdk-js`)

### 0.2.0 — 2026-08-22
- Added external-identity link-challenge support (SPEC.md §2.1): `client.requestLinkChallenge()` / `client.completeLink()`, plus the underlying crypto — `sdk-js/src/crypto/p256.ts` (new: ECDSA P-256 sign/verify via `@noble/curves`, 64-byte compact `r‖s` format matching ATTP), and `verifyRawEd25519`/`toHex`/`fromHex` added to `crypto/keys.ts`.
- New dependency: `@noble/curves`.

### 0.1.0 — 2026-08-22
- Extracted the crypto/canonicalization/receipt-content/`InamClient` code (previously `src/crypto/`, `src/core/`, `src/sdk/client.ts`) into a standalone, independently versioned package published as `inamprotocol` on npm. The Node reference server and Cloudflare Worker now import this code from `sdk-js/` by relative path instead of a local `src/` subfolder — no behavior change, same single source of truth across all three TypeScript runtimes, just made publishable.
- Verified with a real `npm pack` + clean-room install (fresh throwaway project, no workspace/dev context) confirming `InamClient`, `generateKeypair`, and `canonicalize` all work from the published tarball.

## Node reference server & Cloudflare Worker

### 0.4.0 — 2026-08-22 (Phase 4: external identity link challenges)
- Added the external-identity link-challenge flow end-to-end (SPEC.md §2.1) in both runtimes: `POST /agents/:id/link/challenge` issues a single-use, ~60s Ed25519/P-256 challenge; `POST /agents/:id/link` now requires proof of control (`challengeId` + `proofSignature`) for `agentpass_id`/`aitp_id`/`passport_id` — `a2a_endpoint` is unchanged (plain claim, no key to prove control of).
- Worker: challenges live in a new `link_challenges` D1 table (not KV), specifically so consuming one can use the same compare-and-swap discipline (`UPDATE ... WHERE used = 0` + `meta.changes` check) already used for receipt/job state transitions, rather than accepting a weaker guarantee for this one resource.
- Node: `agentService.requestLinkChallenge` / `completeLink` / `linkEndpoint` (split out of the old single `linkIdentity`), backed by an in-memory `Map` (consistent with the idempotency cache — single-process, resets on restart).
- New error codes: `UNSUPPORTED_KEY_TYPE`, `CHALLENGE_NOT_FOUND`, `CHALLENGE_EXPIRED`, `CHALLENGE_ALREADY_USED`, `CHALLENGE_MISMATCH`, `CHALLENGE_REQUIRED`, `PROOF_INVALID`.
- Tests: `tests/linkChallenge.test.ts` (service layer, 8 tests) + `scripts/link-challenge-smoke-test.ts` (Node, real HTTP, 7 checks) + `worker/tests/api.test.ts` additions (5 tests, including a concurrent-completion race regression test), run against both local and the live deployment.

### 0.3.1 — 2026-08-22
- No functional change: repointed internal imports (`src/services/receiptService.ts`, `src/middleware/signedRequest.ts`, `worker/src/receiptService.ts`, `worker/src/signedRequest.ts`, plus scripts/tests) from `src/crypto/` + `src/core/` to the new `sdk-js/src/` package created in this release. Full Node (20) + Worker (16) test suites and the live cross-language interop demo re-verified green after the move.

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

### 0.3.0 — 2026-08-22
- Added external-identity link-challenge support: `request_link_challenge()` / `complete_link()`, plus new `inamprotocol/p256.py` (ECDSA P-256 sign/verify, wrapping `cryptography`'s DER API into the 64-byte compact `r‖s` format ATTP and `sdk-js` use) and `verify_raw_ed25519`/`to_hex`/`from_hex` in `keys.py`. `sdk-python/examples/link_challenge_demo.py` demonstrates both key types against a live server.
- **Fixed a real cross-language interop bug** found while writing that demo: `cryptography`'s raw ECDSA signing doesn't normalize the S value, but `@noble/curves` (the TypeScript/Worker verifier) rejects non-canonical "high-S" signatures by default — so a P-256 signature produced by this SDK verified successfully only about half the time, depending on which of the two equally-valid `(r, s)`/`(r, n−s)` representations OpenSSL happened to produce. `p256_sign` now canonicalizes to low-S before returning. Caught by running the demo repeatedly against a live server, not by a single passing run — a dedicated regression test (`test_p256_signatures_are_always_canonical_low_s`, 64 iterations) guards against it recurring.

### 0.2.0 — 2026-08-22
- Added Job resource methods (`post_job`, `get_job`, `search_jobs`, `submit_offer`, `list_offers`, `accept_offer`, `cancel_job`) — `sdk-python/examples/job_demo.py` demonstrates the full flow, verified against both the local Node server and the live Cloudflare deployment.
- Fixed a latent bug in `register_agent` (and applied the same fix to the new `submit_offer`): an omitted optional field was being sent as JSON `null` instead of leaving the key out entirely. Python's `json.dumps` serializes `None` as `null`, unlike JS's `JSON.stringify`, which drops `undefined`-valued keys — the server's zod schemas treat these fields as optional-if-absent, not nullable, so a literal `null` failed validation.

### 0.1.1 — 2026-08-22
- Set an honest custom User-Agent (`inamprotocol-python-sdk/0.1.0`) — Cloudflare's bot protection on `*.workers.dev` was flagging the default `Python-urllib/x.y` User-Agent.

### 0.1.0 — 2026-08-21
- Initial parity SDK: `did:key`, canonical JSON, Ed25519 signing, `InamClient`. Cross-language correctness verified against fixed TypeScript-generated test vectors and a live two-language demo.
