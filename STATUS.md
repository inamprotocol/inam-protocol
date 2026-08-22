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

- **GitHub**: `github.com/inamprotocol/inam-protocol`, public, `main` branch at commit `87f7f2f` as of this writing.
- **Deployments**: `https://api.inamprotocol.org` (registry API), `https://docs.inamprotocol.org` (spec + API reference), `https://inamprotocol.org` (landing page) — all live Cloudflare Workers.
- **SPEC.md**: v0.5 (Draft).
- **Package versions in the repo** (committed, built, tested) vs. **actually published**:
  | Package | Repo version | Published version (checked 2026-08-23) | Gap |
  |---|---|---|---|
  | `inamprotocol` (npm, `sdk-js`) | 0.3.0 | **0.3.0** | None — up to date |
  | `inamprotocol` (PyPI, `sdk-python`) | 0.4.0 | **0.2.0** | **Two versions behind** — 0.3.0 and 0.4.0 were never published |
- **Test coverage**: 38 Node vitest + 31 Worker vitest + 23 Python pytest = 92 automated tests, all green as of the last full run (2026-08-22).

## Gaps and incomplete items found in this audit

1. **PyPI publish is stuck, blocking.** The user hit `No module named build` running `python -m build` with the system Python interpreter instead of `sdk-python/.venv/Scripts/python.exe`. Told them to use the venv path; **not yet confirmed whether the retry succeeded** — PyPI is still showing 0.2.0 as of this check. This is the single most concrete unfinished task right now: get `inamprotocol@0.4.0` actually published to PyPI (it needs the venv's `build`/`twine`, and the user's own PyPI token).
2. **npm is one version newer than what was last confirmed in conversation** — registry shows 0.3.0 live, meaning the user did publish it (previously confirmed here was 0.1.0, then it should have gone to 0.2.0, now 0.3.0). Not a problem, just noting the registry is ahead of the last explicit confirmation in this file — a reminder that "confirmed live" claims need re-checking, not trusted indefinitely.
3. **OpenWork.network positioning** was researched (its GitHub org has zero public repos, undercutting the "closest competitor" framing from an earlier external analysis) but was never actually written into README's "relationship to other protocols" section (§11 in SPEC.md already has an AgentPass/AITP/Passport Alliance row, but no OpenWork row anywhere, and README doesn't mention it at all). This is a real, still-open documentation gap, not just a "maybe later" — the research is done and sitting unused.
4. **Verification v0.2 backlog** (`docs-design/verification-v0.2-backlog.md`) is a design sketch only. Explicitly not to be started without the user asking — flagging here only so it isn't mistaken for in-progress work.
5. **Phase 5 (payments/stake)** has a real, unresolved prerequisite that isn't a coding task: which payment rail `settlement.paymentRef` actually points at (x402, AP2, on-chain, something else). SPEC.md deliberately leaves this unenforced. This is a product/business decision, flagged in the v0.2 backlog doc too — worth a scoping conversation before any Phase 5 code gets written, not something to default into.
6. **`data/` and `.interop-tmp/` are gitignored and get wiped by nearly every test/demo run** — this is intentional (documented in README), not a gap, but worth stating explicitly so a future session doesn't mistake an empty `data/` directory for data loss.
7. **No CI pipeline** (GitHub Actions or equivalent) exists yet — every test run in this project so far has been manual (`npm test` / `pytest` run by hand before each commit). Not flagged as a problem by the user so far, but it's a real gap for a "protocol" project that wants external contributors to trust it.
8. **npm SDK's `README.md`** (`sdk-js/README.md`) and the Python SDK's `README.md` — not re-audited in this pass for staleness against the latest Verification-resource additions; worth a quick check next time either SDK is touched, since neither was specifically reviewed for the Verification-era changes' documentation completeness (as opposed to the root README/CHANGELOG/SPEC, which were all updated).

## Next action

No default assumed. In rough priority order given what's actually blocking vs. what's just waiting:
1. **Unblock the PyPI publish** (`inamprotocol@0.4.0`) — confirm the venv-python retry worked, or help further if it's still failing.
2. Write the OpenWork positioning into README §11 (research already done, just needs to be written — low effort, closes a real gap).
3. Whenever the user wants: Phase 5 scoping conversation (payment rail decision), Verification v0.2, or a CI pipeline.
