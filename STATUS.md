# Status / Where We Left Off

Last updated: 2026-08-22. This file exists so a new session (human or Claude) can pick up exactly where the last one stopped, without re-deriving it from chat history.

Phase structure adopted (per user + external ChatGPT review of this codebase): **Phase 1 — Hardening** (done) → **Phase 2 — Public protocol** (done) → **Phase 3 — real cross-agent job workflow** (done) → **Phase 4 — verified external identity** (done) → Phase 5 — economic layer (payments/stake) → Phase 6 — network/marketplace.

Alongside the phase list, a second track — an **INAM Verification + Attestation layer** — was proposed by the user (relaying an external design sketch), scoped down together into a locked v0.1, and **shipped this update** (SPEC.md §12, protocol version bumped to v0.5). See "Done and verified" below.

## Done and verified

- **GitHub**: public org `inamprotocol`, public repo `inamprotocol/inam-protocol`, pushed and current.
- **Domain**: `inamprotocol.org` root is live (content-first landing page, `site/`), plus `api.inamprotocol.org` and `docs.inamprotocol.org`.
- **Job resource (SPEC.md §3)** — post → offer → accept → complete/cancel. All three runtimes.
- **External-identity link challenges (SPEC.md §2.1, Phase 4)** — `agentpass_id`/`aitp_id`/`passport_id` require proof of control of the claimed external key (Ed25519 or P-256) via a single-use signed challenge, wire format aligned with ATTP. All three runtimes, live in production.
- **Verification (SPEC.md §12, v0.1 — new this update)** — a single independent verifier's signed attestation that a finalized receipt's output satisfies its job's requirements. Locked scope, agreed with the user before implementation: one verifier per verification, `provider != verifier` strictly enforced, only `deterministic`/`agent_attestation` methods, **no new dispute mechanism** (reuses the existing receipt dispute state — a verified attestation's reputation contribution disappears automatically the instant its receipt is disputed, since the reputation loop only ever sees non-disputed `finalized` receipts), no verifier-side reputation yet.
  - Node: `src/services/verificationService.ts`, `src/routes/verifications.ts` + `GET /receipts/:id/verifications`, `reputationService.ts`'s `ATTESTATION_BOOST` (1.5x) + new `attestedReceipts` component.
  - Worker: same, D1-backed (`worker/src/verificationService.ts`, new `verifications` table — plain `INSERT` suffices, a verification never transitions state after creation, unlike jobs/receipts). Ported by a background fork while the Python SDK was built in parallel in the main session; reviewed and integrated cleanly (31/31 Worker tests).
  - Both SDKs: `submitVerification`/`submit_verification`, `getVerification`/`get_verification`, `listReceiptVerifications`/`list_receipt_verifications`. Also fixed a pre-existing gap in both SDKs — neither had a `getReceipt`/`get_receipt` client method at all.
  - **Real cross-language proof, not just parallel vectors**: `scripts/interop-phase-d-verify.ts` has an independent TypeScript verifier submit a Verification against a receipt that was drafted in Python and finalized in TypeScript — one shared object touched by both SDKs. Live run: the Python worker's `attestedReceipts` went 0→2 and `trustScore` 8.7→12.4. Plus a fixed-vector interop test (`sdk-python/tests/test_verification_interop.py`) proving Python's `compute_verification_id`/canonical JSON/signature are byte-identical to TypeScript's for the same input.
  - Deployed live: D1 migration applied to production (`verifications` table, additive), Worker deployed, full smoke-test suite (existing + new `scripts/verification-smoke-test.ts`) re-verified green against `https://api.inamprotocol.org`.
- **`sdk-js/`**: live on npm as `inamprotocol@0.3.0` (bumped this update — was `0.2.0` before Verification). **`sdk-python/`**: live on PyPI as `inamprotocol@0.4.0` (was `0.3.0`). Both need `npm publish`/`twine upload` run again by the user to actually push v0.3.0/v0.4.0 to the registries — not yet done as of this update (the code and version bumps are committed, but the last two publishes were the user's own action each time).
- Test coverage: 38 Node vitest + 31 Worker vitest + 23 Python pytest = **92 automated tests**, all green. Plus the extended 4-phase cross-language interop demo, `demo.ts`, and three HTTP smoke-test scripts, all re-run against production after this change.
- **`docs-design/verification-v0.2-backlog.md`** (new) — a background-agent-produced design sketch (not normative, not implemented) for the explicitly-deferred v0.2 items: multi-verifier consensus, `human_attestation`/`external_attestation`, verifier-side reputation. Written in parallel with the v0.1 build per the user's request to keep something moving on that track without growing v0.1's scope.

## Open threads

- **Publish `inamprotocol@0.3.0` (npm) and `inamprotocol@0.4.0` (PyPI)**: code is committed and version-bumped; the actual `npm publish`/`twine upload` steps need the user's own credentials, same as every prior publish in this project.
- **Verification v0.2** (multi-verifier consensus, human/external attestation, verifier-side reputation): sketched in `docs-design/verification-v0.2-backlog.md`, not started. Explicitly deferred by the user — don't start without them asking.
- **OpenWork.network positioning**: researched (its GitHub org has zero public repos, undercutting the "closest competitor" framing) but not yet written into README's "relationship to other protocols" section.
- **Phase 5+ (payments/stake, marketplace)**: not started, deliberately. The `docs-design` fork's "Phase 5/6 readiness" note flagged the payment-rail choice as a real unresolved prerequisite that isn't a code decision — worth a scoping conversation before any implementation.
- **Root domain design**: resolved (live, content-first, GNU/npm/PyPI-inspired) — no longer open.

## Next action

No default assumed. Candidates: publish the two pending package versions (needs the user), start scoping Phase 5, write the OpenWork positioning into README, or pick up Verification v0.2 from the backlog doc if the user wants to grow that scope now.
