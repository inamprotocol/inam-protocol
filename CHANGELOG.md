# Changelog

Each package in this repo (Node reference server, Cloudflare Worker, Python SDK) versions independently — they're separate deployables, not a single product release. Protocol-level compatibility is tracked separately: `receiptVersion` in the wire format, and the spec version at the top of `SPEC.md`.

## Protocol specification (`SPEC.md`)

### v0.13 (Draft) — 2026-08-31
- **Made external-identity link assurance explicit (audit #9)**: the `linked` map (§2) presented every external identity identically — a consumer couldn't tell an `a2a_endpoint` (a bare URL, INAM-signed only) from a challenge-verified `agentpass_id`/`aitp_id`/`passport_id`. The registry also didn't record which key a challenge proved, or when.
- New `linkedProof` map on the agent record (§2), keyed by the same protocol names: `{ method, verifiedAt, keyType?, externalPublicKey? }`. `method` is `key_possession` (challenge-verified — proven key + type recorded) or `unverified_claim` (`a2a_endpoint`). `GET /agents/:id/protocols` returns it alongside `linked`.
- Does **not** add cross-registry resolution (still out of scope, §10) — `key_possession` still means "controlled this key at link time," not "this key is authoritative for the identity." The change makes that limit legible in the API.
- `linked` is unchanged — additive and backward compatible. New Worker D1 column `linked_proof` (migration `worker/migration-add-linked-proof.sql` — **must run before deploying** this version's Worker).

### v0.12 (Draft) — 2026-08-30
- **Closed a request-replay gap the same audit found**: the signed-request string (`METHOD\npath\ntimestamp\nsha256(body)`, §7) doesn't cover the `Idempotency-Key`, so a captured signed request replayed with a *fresh* key re-verified and missed the `(caller, key)` idempotency cache — a duplicate side effect on any endpoint without its own content-address/state guard (`POST /jobs` most clearly), for the whole 5-minute clock-skew window.
- §7: a registry now **MUST** bind each verified signature to the one `Idempotency-Key` it was first seen with (for ≥ the skew window) and reject the same signature with a different key as `REPLAYED_REQUEST` (409). Not wire-breaking — the signing string is unchanged, SDKs need no update.
- §7 idempotency tightened: only a terminal **2xx** response is cached/replayed. A transient `5xx`/`429` is no longer cached (it previously pinned the failure for the cache TTL, making a legit retry impossible) — a non-2xx leaves the key unclaimed and a retry re-executes.
- New error code: `REPLAYED_REQUEST`.

### v0.11 (Draft) — 2026-08-30
- **Closed the currency-conflation gap the same audit found**: `GET /agents/:id/reputation` computed `components.volumeUsd` by summing every finalized receipt's `settlement.amount` regardless of `settlement.currency` — a receipt settled in 1000 TRY added 1000 to a USD-labelled field, next to a 25 USDC one. INAM does no FX and won't (§10).
- §5.3's `components` gains `volumeByCurrency` — a `currency → total` map, amounts bucketed by the currency they were denominated in, never converted or cross-summed (keys upper-cased; an untagged amount → `"USD"`). `volumeUsd` is now defined as exactly the `"USD"` bucket; a stablecoin like `USDC` is its own bucket, not USD. `asProvider`/`asRequester` get the same split.
- `settlement.amount`/`currency` and a job's `budget.amount`/`currency` (§3.1, §4.1) are now shape-validated: `amount` a non-negative decimal string, `currency` a `^[A-Za-z0-9]{1,16}$` token — `VALIDATION_ERROR` otherwise. Previously any string passed, so `{ "amount": "banana" }` reached the reputation math and `Number("banana")` → `NaN` poisoned the volume sums; the computation now also guards a non-finite/negative amount as `0` contribution.
- Additive for a consumer reading `volumeUsd`, but its *value* changes for any agent with non-USD settlements (drops to the USD-only total), and a receipt/job with a malformed amount/currency that a prior version accepted is now rejected.

### v0.10 (Draft) — 2026-08-26
- **Closed the actual verifier-independence gap**: v0.6 required a verifier to be "a registered agent," but registration is free and self-service — that requirement never restricted who could verify, so verifier *count* carried no real independence signal and could trivially defeat v0.9's verified-vs-rejected tiebreak by registering throwaway identities.
- New `isAuthorizedVerifier` boolean on the agent record (§2), `false` by default at registration. Only a single registry-configured **operator** identity can flip it, via new `POST /agents/:id/verifier-status` (§12.6). §12.3 rule 4 now checks this flag, not mere registration.
- New error codes: `VERIFIER_NOT_AUTHORIZED` (registered but not operator-authorized), `NOT_OPERATOR` (caller of the new endpoint isn't the configured operator). A registry with no operator configured accepts none of these requests — locked down by default.
- Narrow scope, matching this session's established pattern: a single static operator key, no succession/rotation/multi-operator design (explicit future work, §12.6).

### v0.9 (Draft) — 2026-08-26
- **Closed a reputation-boost exploit the same audit found**: §12.5's eligibility rule required only "at least one `verified` Verification exists," so a single `verified` record granted the boost regardless of how many independent verifiers `rejected` the same receipt — real for a receipt's own two parties (get one colluding/careless verifier to say `verified`), not a missing feature. Tightened to require `verified` strictly outnumbering `rejected` among all Verifications on the receipt.
- Explicitly not a multi-verifier consensus mechanism (still v0.2 backlog, §12.7) — no verifier-trust weighting, no quorum, no new state. The ordinary single-verifier case (`verified`, zero `rejected`) is unaffected.

### v0.8 (Draft) — 2026-08-26
- **Role-aware reputation breakdown** (same external audit): `GET /agents/:id/reputation`'s `components` gains `asProvider`/`asRequester` (§5.3) — the same weighted receipt-count/success-rate/volume signal as the aggregate, filtered by which side of the receipt the agent was on. Purely additive; no existing field changes.
- Prose now explicitly defines `verifiedReceipts` (means finalized/two-party-signed, not independently verified — `attestedReceipts` is the latter) and states the reference `trustScore` formula's ~80 asymptotic ceiling without a live staking mechanism.
- Explicitly deferred: real per-role scoring (`providerScore`/`requesterScore`/`verifierScore` as first-class weighted values) — this version exposes the raw signal, not a new scoring model.

### v0.7 (Draft) — 2026-08-26
- **Closed a reputation-inflation gap the same audit found**: the decay formula (§5.2) had no bounds on `result.completedAt` — a future timestamp makes `ageDays` negative, so `2^(-ageDays/halfLife)` becomes a decay factor *greater than 1*, weighting a receipt claiming future completion as more trustworthy than one completing right now, unboundedly the further out the date.
- New `INVALID_TIMESTAMP` validation (§4.3): a draft receipt's `result.completedAt` is rejected if it's more than a small clock-skew tolerance in the future, or precedes `task.createdAt`. `task.createdAt`/`result.completedAt` must now also be valid date-time strings (previously any non-empty string passed).
- Decay is now specified as clamped to `[0, 1]` (§5.2) regardless of the above — defense for any receipt stored before this validation existed, and for any other source of a non-finite/out-of-range value.
- Verified the stricter date-format check doesn't break either SDK: TypeScript's `toISOString()` and Python's `datetime.isoformat()` produce different suffix styles (`Z` vs. `+00:00`) and fractional-second precision — both confirmed accepted, live, against a local server with the real Python SDK, including a live-reproduced future-date rejection.
- Additive and backward compatible — rejects only requests that were previously accepted by mistake.

### v0.6 (Draft) — 2026-08-26
- **Closed a verifier-independence gap an external audit found**: §12.3's self-verification guard checked only `verifier != provider`, so a receipt's *requester* (already a party to the same receipt via countersigning it) could name itself "independent verifier" with no check at all. Now excludes both parties.
- New requirement: `verifier` must be a registered agent (`AGENT_NOT_FOUND` otherwise) — doesn't prove independence (out of scope, see §0), only that it's a real registry participant.
- New requirement: a verifier may submit at most one decision per receipt (`VERIFIER_ALREADY_DECIDED`) — previously the same verifier could submit both `verified` and `rejected` for one receipt (different content sidesteps the existing content-hash duplicate check) with both standing as live, contradictory records.
- Additive, backward compatible — no wire-format change; new checks only reject requests that were previously (unintentionally) accepted.

### v0.5 (Draft) — 2026-08-22
- Added the **Verification** resource (§12): a single independent verifier's signed attestation that a finalized receipt's output satisfies its job's requirements — the enforcement mechanism `verification.method: independent_validator`/`test_suite_pass` never had, called out as a gap since v0.1.
- Deliberately narrow v0.1 scope, agreed with the user before implementation started: exactly one verifier per verification (no multi-verifier consensus), `provider != verifier` strictly enforced (the core collusion guard), only `deterministic`/`agent_attestation` methods, **no new dispute mechanism** — reuses the existing receipt dispute state (§4.3) rather than inventing a second one, and a `verified` Verification's reputation contribution disappears automatically the moment its receipt is disputed (the reputation computation's `finalized` filter already excludes disputed receipts — no separate check needed). No verifier-side reputation yet.
- Reputation linkage: `computeReputation` (§5.2) applies a weight multiplier to a finalized, non-disputed receipt with at least one `verified` Verification, and reports the count as a new `attestedReceipts` component (§5.3) — no second event ledger, same principle as §5.1.
- New error codes: `RECEIPT_NOT_FINALIZED`, `NOT_VERIFIER`, `SELF_VERIFICATION`, `VERIFICATION_TARGET_MISMATCH`, `UNSUPPORTED_VERIFICATION_METHOD`, `INVALID_VERIFICATION_SIGNATURE`, `DUPLICATE_VERIFICATION`, `VERIFICATION_NOT_FOUND`.
- Explicitly deferred to a v0.2 backlog (§12.7): multi-verifier consensus, `human_attestation`/`external_attestation` methods (including passthrough for other systems' own attestations), verifier-side reputation, auto-dispute on rejection. A design sketch for these lives in `docs-design/verification-v0.2-backlog.md` — exploratory, not normative.
- Implemented and verified in all three runtimes (Node, Cloudflare Workers, both SDKs), including a real cross-language proof: a receipt drafted in Python, finalized in TypeScript, then independently verified by a third TypeScript identity — correctly boosting the Python-side provider's reputation (`attestedReceipts` 0→2, `trustScore` 8.7→12.4 in the live demo run).

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

### 0.3.4 — 2026-08-31
- `AgentRecord` type gains `linkedProof: LinkedIdentityProofs` (SPEC.md v0.13, §2). New exported types `LinkProof` / `LinkedIdentityProofs`. Additive; no client method change.

### 0.3.3 — 2026-08-30
- `ReputationComponents` / `ReputationRoleBreakdown` types gain `volumeByCurrency: Record<string, number>` (SPEC.md v0.11, §5.3). `volumeUsd` stays, now documented as the `"USD"` bucket only.
- `settlement.amount`/`currency` and `budget.amount`/`currency` in `sdk-js/src/core/schemas.ts` are now regex-validated (non-negative decimal string / short currency-code token) instead of bare `z.string()`. New `sdk-js/src/core/settlementVolume.ts` (`normalizeCurrency`/`parseSettlementAmount`/`accrueVolume`/`roundVolumes`) — the per-currency aggregation shared by both server runtimes.

### 0.3.2 — 2026-08-26
- Added `client.setVerifierStatus(targetAgentId, authorized)` (SPEC.md v0.10, §12.6) — grants or revokes an agent's `isAuthorizedVerifier` flag. Only succeeds when the calling keypair is the registry's configured operator identity; anyone else gets `NOT_OPERATOR`. New `setVerifierStatusSchema` exported from `sdk-js/src/core/schemas.ts`.

### 0.3.1 — 2026-08-25
- **Fixed a real, live cross-language signature bug**: `canonicalize()` now rejects `NaN`/`Infinity`/`-Infinity` outright instead of silently delegating to `JSON.stringify`, which turns all three into the string `"null"` — previously capable of corrupting a signed value with no error on either side. Number formatting itself was already correct here (native `JSON.stringify` follows ECMA-262 `Number::toString` by definition); the matching fix on the Python side (below) is what actually resolves the live bug, this side only closes the NaN/Infinity gap. New test vectors in `tests/canonical.test.ts` shared byte-for-byte with `sdk-python/tests/test_canonical.py`.

### 0.3.0 — 2026-08-22
- Added the Verification resource (SPEC.md §12): `client.submitVerification()`, `client.getVerification()`, `client.listReceiptVerifications()`, plus `sdk-js/src/core/verificationContent.ts` (`computeVerificationId`/`buildSignableVerificationContent` — same content-addressing pattern as receipts). `submitVerification` fetches the referenced receipt itself to derive `jobId`/`provider` rather than trusting caller input, since the server independently re-derives the same values and would reject a signature built over the wrong ones.
- Also added `client.getReceipt(id)` — a pre-existing gap (`GET /v1/receipts/:id` had no client method at all) found and fixed while wiring `submitVerification`.

### 0.2.0 — 2026-08-22
- Added external-identity link-challenge support (SPEC.md §2.1): `client.requestLinkChallenge()` / `client.completeLink()`, plus the underlying crypto — `sdk-js/src/crypto/p256.ts` (new: ECDSA P-256 sign/verify via `@noble/curves`, 64-byte compact `r‖s` format matching ATTP), and `verifyRawEd25519`/`toHex`/`fromHex` added to `crypto/keys.ts`.
- New dependency: `@noble/curves`.

### 0.1.0 — 2026-08-22
- Extracted the crypto/canonicalization/receipt-content/`InamClient` code (previously `src/crypto/`, `src/core/`, `src/sdk/client.ts`) into a standalone, independently versioned package published as `inamprotocol` on npm. The Node reference server and Cloudflare Worker now import this code from `sdk-js/` by relative path instead of a local `src/` subfolder — no behavior change, same single source of truth across all three TypeScript runtimes, just made publishable.
- Verified with a real `npm pack` + clean-room install (fresh throwaway project, no workspace/dev context) confirming `InamClient`, `generateKeypair`, and `canonicalize` all work from the published tarball.

## Node reference server & Cloudflare Worker

### 0.6.7 — 2026-08-31 (external audit fixes, continued)
- **`linkedProof` assurance metadata (SPEC.md v0.13, §2, audit #9)**: both runtimes now record, per linked external identity, how it was verified — `key_possession` (challenge-verified, with the proven `keyType` + `externalPublicKey`) or `unverified_claim` (`a2a_endpoint`). Returned on the agent record everywhere and explicitly by `GET /agents/:id/protocols`. `linked` unchanged.
- New D1 column `agents.linked_proof` (`worker/schema.sql` + `worker/migration-add-linked-proof.sql`). **Migration must run against production D1 before deploying** — `insertAgent` names the column; `rowToAgent` tolerates its absence on read only. Node reference: `getAgent` defaults the field for records persisted before it existed.
- `worker/src/db.ts`: `updateAgentLinked` → `updateAgentLinks` (writes `linked` + `linked_proof` in one UPDATE).
- Live cross-language proof: Python SDK linked an `a2a_endpoint` + a challenge-verified `agentpass_id` against a running Node server; `linkedProof` came back `{a2a_endpoint: {method: "unverified_claim"}, agentpass_id: {method: "key_possession", keyType: "ed25519", externalPublicKey: …}}`, confirmed via `GET /agents/:id` and `GET /protocols`. New regression tests (Node 75→76, Worker 52→53; Python 36 unchanged, 165 total).

### 0.6.6 — 2026-08-30 (external audit fixes, continued)
- **Signature-replay guard (SPEC.md v0.12, §7, audit #8)**: `requireIdempotencyKey` (both runtimes) now binds each verified request signature to the single `Idempotency-Key` it was first presented with; the same signature with a different key is rejected `REPLAYED_REQUEST` (409). Closes the "replay a captured signed request with a fresh key" hole without touching the signing string (SDKs unchanged). Node keeps the binding in a new in-memory `signatureReplayCache` (TTL = clock-skew window), Worker in the existing KV namespace under a `replay:` prefix (300s TTL).
- **Idempotency now caches successes only**: a non-2xx response is no longer stored — previously a transient `5xx`/`429` pinned the key for the full TTL and a legitimate retry could never get through. Node also gave `idempotencyCache` TTL eviction + a bounded opportunistic sweep (it previously grew unbounded from unique keys — a slow memory-exhaustion vector).
- No DB migration. Live replay proof against a running Node server: same signature + fresh key → 409 `REPLAYED_REQUEST`, verbatim replay → cached 201 (no second job), exactly one job created despite 3 POSTs. New regression tests (Node 73→75, Worker 51→52; Python 36 unchanged, 163 total).

### 0.6.5 — 2026-08-30 (external audit fixes, continued)
- **Currency conflation in reputation volume (SPEC.md v0.11, §5.3)**: `computeReputation` (both runtimes) now buckets `settlement.amount` by `settlement.currency` into `components.volumeByCurrency` instead of summing every currency into one `volumeUsd` number. `volumeUsd` is now the `"USD"` bucket alone (untagged amounts still count as USD); `USDC` and every other currency stay out of it. Same split added to `asProvider`/`asRequester`.
- Malformed/negative `settlement.amount` or free-form `currency` (and the same on a job's `budget`) now rejected with `VALIDATION_ERROR` at the shared schema layer; the volume math also guards a non-finite/negative amount as `0`.
- New shared module `sdk-js/src/core/settlementVolume.ts` imported by both `src/services/reputationService.ts` and `worker/src/reputationService.ts`. No DB migration — this is compute-only over existing receipt rows.
- Live cross-language proof: Python SDK drafted USD/TRY/USDC receipts against a running Node server; `volumeUsd` came back `100` (the USD receipt only, not `1125.5`), `volumeByCurrency` `{USD:100, TRY:1000, USDC:25.5}`, lowercase `"usdc"` normalized, malformed amount rejected `400`. New regression tests (Node 73, Worker 51, Python 36).

### 0.6.4 — 2026-08-26 (external audit fixes, continued)
- **Operator-authorized verifiers (SPEC.md v0.10, §12.3/§12.6)**: closes the actual verifier-independence gap left by v0.6's "must be a registered agent" rule — registration is free and self-service, so that rule never restricted who could verify, only that they'd registered first. Verifier eligibility is now an explicit grant: a new `isAuthorizedVerifier` boolean on `AgentRecord`, `false` by default at registration, settable only by a single registry-configured operator identity (`INAM_OPERATOR_DID` env var, Node; `OPERATOR_DID` binding, Worker — both unset by default, the locked-down state) via new `POST /agents/:id/verifier-status`. `submitVerification` (both runtimes) now checks this flag instead of mere registration, rejecting `VERIFIER_NOT_AUTHORIZED`; a non-operator calling the new endpoint gets `NOT_OPERATOR`.
- New D1 migration `worker/migration-add-verifier-status.sql` (`ALTER TABLE agents ADD COLUMN is_authorized_verifier`) — **must run against production D1 before deploying this version's Worker code**, since `worker/schema.sql`'s `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table.
- New client methods: `InamClient.setVerifierStatus()` (sdk-js 0.3.2), `InamClient.set_verifier_status()` (sdk-python 0.4.2).
- Live-proven end to end against a real running Node server with a real operator keypair: outsider grant attempt correctly rejected (`NOT_OPERATOR`), operator grant correctly applied, operator revoke correctly applied and immediately re-blocks verification submission. New regression tests in both runtimes covering unauthorized-registered-verifier rejection, non-operator-grant rejection, and operator revocation (Node 67, Worker 49).

### 0.6.3 — 2026-08-26 (external audit fixes, continued)
- **Fixed a reputation-boost exploit (SPEC.md v0.9, §12.5)**: `hasVerifiedAttestation` (both runtimes) required only "at least one verified" among a receipt's Verifications, so a single colluding/careless verifier's `verified` unconditionally outvoted any number of independent `rejected` records from other verifiers. Now requires `verified` to strictly outnumber `rejected` — a narrow strict-majority tiebreak, not the multi-verifier consensus mechanism explicitly deferred to v0.2 (no verifier-trust weighting, no quorum). The ordinary single-verifier case is unaffected.
- Live-reproduced end to end (real local server, real SDK): 1 `verified` + 2 independent `rejected` no longer grants `attestedReceipts`; 1 `verified` + 0 `rejected` still does. New regression tests in both runtimes for both cases (Node 64, Worker 46).

### 0.6.2 — 2026-08-26 (external audit fixes, continued)
- **Role-aware reputation breakdown (SPEC.md v0.8, §5.3)**: `computeReputation` (both runtimes) now also tracks `asProvider`/`asRequester` sub-totals using the same weighting as the existing aggregate (`pairWeight * counterpartyTrust * decay * attestationBoost`), filtered by whether the agent was `agentB` (provider) or `agentA` (requester) on each finalized receipt. `ReputationComponents` gains the two new fields (`sdk-js/src/types.ts`, plus the same duplicated type in `src/types.ts`/`worker/src/types.ts` per this repo's existing per-runtime-type convention). Purely additive.
- New regression test in both runtimes proving two agents in different provider/requester mixes get correctly differentiated breakdowns, with the role counts summing back to the existing `verifiedReceipts` total (Node 62 tests, Worker 44).

### 0.6.1 — 2026-08-26 (external audit fixes, continued)
- **Reputation date/future-dating safety (SPEC.md v0.7, §4.3/§5.2)**: a draft receipt's `result.completedAt` is now rejected (`INVALID_TIMESTAMP`) if it's more than 5 minutes in the future or precedes `task.createdAt`; both timestamps must now be valid date-time strings (`sdk-js/src/core/schemas.ts`'s `isoDateTime`, `z.string().datetime({ offset: true })` — accepts both TS's and Python's ISO output, confirmed live with the real Python SDK). Decay is also now clamped to `[0, 1]` in `reputationService.ts` (both runtimes) as defense for any receipt already stored, and a non-finite computed weight is treated as zero contribution rather than corrupting the whole agent's score via `NaN` propagation.
- New regression tests in both runtimes: future-completedAt rejection, completedAt-before-createdAt rejection, non-ISO completedAt rejection at the schema layer (Worker only, HTTP-level) — 8 new tests total (Node 61, Worker 43).

### 0.6.0 — 2026-08-26 (external audit fixes)
- **Verifier independence (SPEC.md v0.6, §12.3)**: self-verification guard now excludes the receipt's requester as well as its provider; a verifier must be a registered agent (`AGENT_NOT_FOUND` otherwise); a verifier may submit at most one decision per receipt (`VERIFIER_ALREADY_DECIDED`). New regression tests in both runtimes reproducing each gap directly.
- **Request-validation parity between Node and the Worker**: the Worker previously only checked that mutating-request fields were *present*, never that their values were valid (e.g. a signed `POST /v1/verifications` with `{"result":"banana","score":999}` was accepted by the Worker, rejected by Node). Every Zod schema moved from `src/routes/*.ts` into `sdk-js/src/core/schemas.ts` — one shared source both runtimes import, not two independently-maintained copies.
- **Malformed JSON now returns 400 `INVALID_JSON`, not 500**, on both runtimes — previously an uncaught `SyntaxError` from body-parsing fell through to the generic 500 handler on each, misreporting a client mistake as a server bug.
- Added the embeddable reputation badge: `GET /v1/agents/:id/badge.svg` / `.json` (shields.io-style, green/yellow/red by trust score, neutral grey for zero-history/unknown agents, never interpolates agent-supplied text into the SVG).
- `sdk-js` gained `@types/node` as an explicit dependency — its own `npm run build` failed in true isolation (no parent `node_modules` to fall back on) with "Cannot find name 'Buffer'"/`TextEncoder`/`fetch`, exposed by (and now fixed for) the npm publish workflow specifically, since every other local/CI build path had root's `node_modules` present as a masking ancestor directory.
- 129 tests green across all three runtimes after this batch (56 Node + 37 Worker + 36 Python).

### 0.5.0 — 2026-08-22 (Verification v0.1)
- Added the Verification resource end-to-end (SPEC.md §12) in both runtimes: `POST /v1/verifications`, `GET /v1/verifications/:id`, `GET /v1/receipts/:id/verifications`. Worker stores verifications in a new `verifications` D1 table (plain `INSERT`, no compare-and-swap needed — a verification never transitions state after creation, unlike jobs/receipts); Node uses the same `JsonStore` pattern as everything else.
- `reputationService` (both runtimes): a finalized, non-disputed receipt backed by a `verified` Verification gets a 1.5x weight multiplier; a new `attestedReceipts` component reports the count for auditability. A `rejected` Verification applies no weight change (evidence only, scoring-neutral in this version).
- Node: 10 service-level tests (`tests/verificationFlow.test.ts`) + an HTTP smoke test (`scripts/verification-smoke-test.ts`, runnable against either runtime via `INAM_URL` — used to prove Node/Worker behavioral parity). Worker: the same 10 cases ported to `worker/tests/api.test.ts` (31 tests total after the port), including the concurrent-duplicate-submission race case.
- Cross-language proof beyond the existing fixed-vector interop test: `scripts/interop-phase-d-verify.ts` (new phase D of the TS↔Python demo) has a fresh, independent TypeScript-side verifier submit a Verification against a receipt that was drafted in Python and finalized in TypeScript — a real object touched by both SDKs, not just parallel same-input vectors. Confirmed live: `attestedReceipts` 0→2 and `trustScore` 8.7→12.4 on the Python worker's reputation.
- Deployed live: D1 migration applied to production (`verifications` table, additive), Worker deployed and re-verified against `https://api.inamprotocol.org`.

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

### 0.4.2 — 2026-08-26
- Added `set_verifier_status(target_agent_id, authorized)` (SPEC.md v0.10, §12.6) — mirrors the TypeScript SDK's `client.setVerifierStatus()`.

### 0.4.1 — 2026-08-25
- **Fixed a critical, live cross-language signature bug**: `canonicalize()`'s number formatting used Python's own `json.dumps`/`repr` rules (`1.0`, `1e-07`, `1e+20`, `-0.0`), which disagree with JavaScript's `JSON.stringify` (`1`, `1e-7`, `100000000000000000000`, `0`) for ordinary values — observed live as `submit_verification(..., score=1.0)` failing `INVALID_VERIFICATION_SIGNATURE` against the (always-TypeScript) server while `score=0.99` succeeded, with no actual tampering involved. `canonical.py`'s `_format_number` now reimplements the ECMA-262 `Number::toString` algorithm directly, so Python produces the exact digit string JavaScript would for the same value. Also now rejects `NaN`/`Infinity`/`-Infinity` explicitly (`ValueError`) rather than letting them reach `json.dumps` and produce a non-JSON literal. 17 new shared test vectors in `tests/test_canonical.py`, mirrored byte-for-byte in `sdk-js`'s `tests/canonical.test.ts`; the exact live-reproduced case (`score: 1.0`) is a dedicated regression test in both.
- **Fixed a second, independent bug found while investigating the above**: the HTTP `user-agent` header was hardcoded to `inamprotocol-python-sdk/0.1.0` since the 0.1.1 release and never updated across four subsequent releases — every request from every installed version of this SDK misidentified itself as the first release. Now read from the installed package's own metadata (`importlib.metadata.version("inamprotocol")`) instead of a literal, so it can't drift out of sync with `pyproject.toml` again.

### 0.4.0 — 2026-08-22
- Added the Verification resource (SPEC.md §12): `submit_verification()`, `get_verification()`, `list_receipt_verifications()`, plus `inamprotocol/verification.py` (`compute_verification_id`/`build_signable_verification_content`, mirroring `sdk-js/src/core/verificationContent.ts`). Also added `get_receipt(receipt_id)` (same pre-existing gap as the TS SDK).
- New `tests/test_verification_interop.py`: a fixed-vector cross-language test (ground truth generated once by `scripts/interop-vectors.ts`) proving `compute_verification_id`, the canonical JSON of the signed content, and the Ed25519 signature are all byte-identical to the TypeScript SDK for the same input and key — the real acceptance bar for this being one protocol rather than two similar SDKs.
- New `examples/verification_demo.py`.

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
