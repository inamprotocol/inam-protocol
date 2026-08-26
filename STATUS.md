# Status / Where We Left Off

Last updated: 2026-08-23. This file exists so a new session (human or Claude) can pick up exactly where the last one stopped, without re-deriving it from chat history. It is a full audit, not just a pointer — read it before trusting any specific claim elsewhere, and re-verify anything time-sensitive (published package versions, live deployment state) rather than assuming this file is still current forever.

## Phase overview

| Phase | Status | Notes |
|---|---|---|
| 1 — Hardening | **Done** | D1 race fixes, rate limiting, CORS policy, FK enforcement, real Worker test suite |
| 2 — Public protocol | **Done** | GitHub org/repo, docs site, OpenAPI, versioning discipline |
| 3 — Real cross-agent job workflow | **Done** | Job resource (SPEC.md §3), all three runtimes |
| 4 — Verified external identity | **Done** | Link challenges (SPEC.md §2.1), ATTP-aligned, all three runtimes |
| Verification v0.1 (added mid-stream, not in the original phase list) | **Done** | SPEC.md §12, all three runtimes, live in production |
| 5 — Economic layer (payments/stake) | **Not started** | Deliberately deferred; real prerequisite (payment rail choice) is a product decision, not scoped here |
| 6 — Network/marketplace | **Not started** | Deliberately deferred |
| Verification v0.2 (backlog) | **Not started, sketched only** | `docs-design/verification-v0.2-backlog.md` — design notes, no code |

## What's actually done and verified, phase by phase

### Phase 1 — Hardening
D1 compare-and-swap fixes for receipt countersign/dispute, agent registration race fix, rate limiting (both runtimes), CORS policy, D1 foreign-key enforcement, reputation O(receipts) cost-amplification fix, real Worker test suite via `@cloudflare/vitest-plugin`.

### Phase 2 — Public protocol
GitHub org `inamprotocol` / repo `inamprotocol/inam-protocol` (public, Apache-2.0). `docs.inamprotocol.org` (rendered SPEC.md + Redoc API reference). `openapi.yaml`, versioned CHANGELOG.md with per-package sections. Root domain `inamprotocol.org` deployed (content-first landing page, `site/`) as part of this track's follow-through, though it happened later chronologically.

### Phase 3 — Job resource (SPEC.md §3)
`open → accepted → completed/cancelled`, offers as a separate table (avoids concurrent-offer races), receipt↔job consistency checks. All three runtimes, all SDKs.

### Phase 4 — External identity link challenges (SPEC.md §2.1)
`agentpass_id`/`aitp_id`/`passport_id` require a signed challenge (Ed25519 or P-256) proving control of the claimed key before linking; `a2a_endpoint` unaffected. Wire format aligned with ATTP (`draft-sharif-attp-00`, real IETF draft, confirmed via research — not assumed). A real cross-language bug was found and fixed here: Python's raw ECDSA P-256 signing didn't canonicalize to low-S, so it verified against the TS/Worker side only ~50% of the time; fixed with a regression test guarding it.

### Verification v0.1 (SPEC.md §12)
A single independent verifier's signed attestation that a finalized receipt's output satisfies its job's requirements. Scope locked with the user before implementation: one verifier per verification, `provider != verifier` enforced, only `deterministic`/`agent_attestation` methods, no new dispute mechanism (reuses the existing receipt dispute state — verified reputation contribution disappears automatically the instant a receipt is disputed, since reputation computation only iterates non-disputed `finalized` receipts). Reputation gets a weight boost + new `attestedReceipts` component, no second event ledger. All three runtimes; Worker port was done by a background fork while the Python SDK was built in parallel in the main session, then integrated and reviewed. Real cross-language proof: a receipt drafted in Python, finalized in TypeScript, then independently verified by a third TypeScript identity — live run showed `attestedReceipts` 0→2 and `trustScore` 8.7→12.4. D1 migration applied to production, Worker deployed, full smoke-test suite green against `https://api.inamprotocol.org`.

## Current live state (verify independently before relying on this — it decays fast)

- **GitHub**: `github.com/inamprotocol/inam-protocol`, public, `main` branch at commit `1ab2b95` as of this writing (2026-08-25). Branch protection on `main` now requires all 4 CI checks; repo "About" field set.
- **Deployments**: `https://api.inamprotocol.org` (registry API, now including `GET /agents/:id/badge.svg`/`.json`), `https://docs.inamprotocol.org` (spec + API reference), `https://inamprotocol.org` (landing page), **`https://explorer.inamprotocol.org`** (new, 2026-08-25 — read-only public browser + live stats dashboard) — all live Cloudflare Workers, all verified responding 2026-08-25.
- **SPEC.md**: v0.5 (Draft).
- **Package versions in the repo** (committed, built, tested) vs. **actually published**:
  | Package | Repo version | Published version (checked 2026-08-25) | Gap |
  |---|---|---|---|
  | `inamprotocol` (npm, `sdk-js`) | 0.3.1 | **0.3.1** | None — published via the new trusted-publishing workflow after a real bug (a critical cross-language canonical-JSON signature bug — see below) |
  | `inamprotocol` (PyPI, `sdk-python`) | 0.4.1 | **0.4.1** | None — same release, same fix |
- **2026-08-25/26: an external audit found 15 issues; #1-#4 are fixed, 11 remain.**
  - **#1 (critical, live) — fixed & republished.** `score: 1.0` submitted via the Python SDK failed `INVALID_VERIFICATION_SIGNATURE` (server is always TypeScript; Python's `json.dumps` and JS's `JSON.stringify` disagree on number formatting for ordinary values). Live-reproduced before/after. `sdk-js@0.3.1`/`sdk-python@0.4.1` on npm/PyPI.
  - **#2 (P0) — fixed.** Node/Worker request-validation parity: the Worker only checked required fields were *present*, never valid (a signed `{"result":"banana","score":999}` passed on the Worker, was rejected by Node). Fixed by extracting every Zod schema into `sdk-js/src/core/schemas.ts` (one shared source, not two copies) and wiring both runtimes to it. Also fixed while in the same area: malformed JSON returned 500 instead of 400 on both runtimes (confirmed live, now 400 `INVALID_JSON` on both).
  - **#3 (P0) — fixed, SPEC.md bumped to v0.6.** Verifier independence: self-verification guard excluded only the provider, not the requester (who could name itself "independent verifier" after already approving the same work); an unregistered `verifier` was never checked; the same verifier could submit contradictory `verified`+`rejected` records for one receipt. All three closed in both runtimes — requester now excluded too, `AGENT_NOT_FOUND` for unregistered verifiers, new `VERIFIER_ALREADY_DECIDED` for a second decision. Deliberately not done: a DB-level FK on `verifications.verifier` in `worker/schema.sql` — live-DB migration risk judged not worth it when the application-level check gives the same protection; flagged as a real follow-up.
  - **#4 (P0) — fixed, SPEC.md bumped to v0.7.** Reputation inflation via future-dated receipts: the decay formula had no bounds on `result.completedAt`, so a future date produced a decay factor >1 (unboundedly more trust for claiming completion further in the future) instead of being rejected. Fixed: new `INVALID_TIMESTAMP` check (>5min future or before `createdAt`), strict ISO date-format validation (verified compatible with both TS's and Python's differing timestamp formats, live-tested with the real Python SDK), and decay clamped to `[0,1]` as defense for pre-existing data.
  - **11 remaining** (not started): provider/requester score conflation, rejected-verification handling, currency conflation in `volumeUsd`, replay/idempotency hardening, external-identity verification depth, key management, job/dispute state-machine completeness, no agent runtime, privacy/access control, search/reputation scaling, doc/version drift. Being worked through in the user's own priority order (P0 first).
- **Test coverage**: 61 Node vitest + 43 Worker vitest + 36 Python pytest = 140 automated tests, all green 2026-08-26 after the audit fixes above.

## Gaps and incomplete items found in this audit

1. ~~**PyPI publish is stuck, blocking.**~~ **Resolved, confirmed 2026-08-24.** PyPI shows `inamprotocol@0.4.0`, released 2026-08-22 — the venv retry did succeed, this file just hadn't been updated to reflect it. Noted separately below: the release was uploaded with plain `twine`, not PyPI Trusted Publishing — see the new CI/security item.
2. **npm is one version newer than what was last confirmed in conversation** — registry shows 0.3.0 live, meaning the user did publish it (previously confirmed here was 0.1.0, then it should have gone to 0.2.0, now 0.3.0). Not a problem, just noting the registry is ahead of the last explicit confirmation in this file — a reminder that "confirmed live" claims need re-checking, not trusted indefinitely.
3. ~~**OpenWork.network positioning**~~ **Resolved 2026-08-24.** Added as a row in SPEC.md §11 — flagged as an overlapping-claim, zero-public-repos, unverified-implementation competitor rather than a peer protocol to interoperate with.
4. **Verification v0.2 backlog** (`docs-design/verification-v0.2-backlog.md`) is a design sketch only. Explicitly not to be started without the user asking — flagging here only so it isn't mistaken for in-progress work.
5. **Phase 5 (payments/stake)** has a real, unresolved prerequisite that isn't a coding task: which payment rail `settlement.paymentRef` actually points at (x402, AP2, on-chain, something else). SPEC.md deliberately leaves this unenforced. This is a product/business decision, flagged in the v0.2 backlog doc too — worth a scoping conversation before any Phase 5 code gets written, not something to default into.
6. **`data/` and `.interop-tmp/` are gitignored and get wiped by nearly every test/demo run** — this is intentional (documented in README), not a gap, but worth stating explicitly so a future session doesn't mistake an empty `data/` directory for data loss.
7. **No CI pipeline** (GitHub Actions or equivalent) exists yet — every test run in this project so far has been manual (`npm test` / `pytest` run by hand before each commit). Not flagged as a problem by the user so far, but it's a real gap for a "protocol" project that wants external contributors to trust it.
8. **npm SDK's `README.md`** (`sdk-js/README.md`) and the Python SDK's `README.md` — not re-audited in this pass for staleness against the latest Verification-resource additions; worth a quick check next time either SDK is touched, since neither was specifically reviewed for the Verification-era changes' documentation completeness (as opposed to the root README/CHANGELOG/SPEC, which were all updated).
9. **Neither package uses provenance/trusted publishing.** `inamprotocol@0.4.0` on PyPI was uploaded with plain `twine` (no PyPI Trusted Publishing / OIDC); npm side likewise has no `npm publish --provenance`. Both require the user's own action on the npm/PyPI project settings pages (this session can write the GitHub Actions workflow side, not flip the account-level toggle) — flagged, not started.
10. **Zero external-adoption signal** — 0 GitHub stars/forks/issues/releases as of this writing, no example integrations, no quickstart shorter than reading the full README. This isn't a code gap, it's *the* current bottleneck: the protocol works (92/92 tests, all three domains live) but nothing outside this repo has used it yet.

## Next action

2026-08-24 direction-setting: three external LLM reviews (ChatGPT, DeepSeek, Qwen) independently converged on the same read — the protocol core is done and verified (confirmed again today: 92/92 tests green, api/docs/site all live), and the real bottleneck from here is adoption, not more protocol surface. Agreed with that read; STATUS.md's own phase table already had "5 — Adoption/Network: Not started" before this session. Decided **not** to start Phase 5/6/7 protocol features (network directory, payments, federation) — those still need the payment-rail product decision from gap 5 above — and instead to close the adoption *prerequisites* that were sitting as open gaps in this very file: CI (gap 7), SECURITY.md/CONTRIBUTING.md/provenance groundwork (gap 9), a real 5-minute quickstart, and one concrete "add INAM to an existing agent" framework-integration example. Two background agents were dispatched same-session to draft these (isolated git worktrees, not yet merged — see PR/branch names in the next session's `git branch` output if this file wasn't updated again after they landed).

Rough priority order from here:
1. Review and merge whatever the two dispatched agents produced (CI+security track, quickstart+integration-example track).
2. Whenever the user wants: Phase 5 scoping conversation (payment rail decision), Verification v0.2, npm/PyPI trusted-publishing toggle (needs the user's own account access), or an actual adoption push (posting the quickstart somewhere developers will see it).
