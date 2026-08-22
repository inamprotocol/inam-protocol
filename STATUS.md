# Status / Where We Left Off

Last updated: 2026-08-22. This file exists so a new session (human or Claude) can pick up exactly where the last one stopped, without re-deriving it from chat history.

Phase structure adopted (per user + external ChatGPT review of this codebase): **Phase 1 — Hardening** (done, this update) → **Phase 2 — Public protocol** (GitHub, docs, SDK polish, versioning, examples) → Phase 3 — real cross-agent job workflow → Phase 4 — verified external identity → Phase 5 — economic layer (payments/stake) → Phase 6 — network/marketplace.

## Phase 1 — Hardening: done

All seven items from the 2026-08-22 audit are fixed and verified (local `wrangler dev`, local vitest suite, and the live Cloudflare deployment):

1. **D1 race condition (countersign)** — fixed via compare-and-swap: `worker/src/db.ts`'s `finalizeReceiptIfDraft()` does `UPDATE ... WHERE status='draft'` and checks `meta.changes`, replacing the old read-then-write. Same pattern applied to `disputeReceiptIfFinalized()`.
2. **Agent registration race** — fixed via plain `INSERT` (no `ON CONFLICT`) in `insertAgent()`; a racing duplicate now hits SQLite's UNIQUE constraint and is caught as `AGENT_ALREADY_REGISTERED`, instead of silently upserting.
3. **Rate limiting** — added to both runtimes with the same policy: registration limited by IP (a DID is free to mint, so DID-scoping would do nothing against spam), signed writes limited by DID, and the two expensive public reads (`search`, `reputation`) limited by IP. Worker uses Cloudflare's native `RateLimit` binding (`worker/src/rateLimit.ts`); Node uses an in-memory fixed-window limiter (`src/middleware/rateLimit.ts`) — fine for a single-process reference server.
4. **CORS decision made and implemented** — public GET reads get `Access-Control-Allow-Origin: *` (matches "reputation is public, no account needed"); signed POST/mutating routes get no CORS headers at all (they're server-to-server by design, and since auth is a per-request Ed25519 signature rather than an ambient browser credential, CORS doesn't add real security there anyway — documented in both `worker/src/index.ts` and `src/server.ts`).
5. **D1 foreign key enforcement** — `PRAGMA foreign_keys = ON` now runs batched with every receipt insert (`insertDraftReceipt`), since D1 doesn't guarantee the pragma persists across whatever session backs a given `env.DB` call.
6. **Security review conducted** — found and fixed a real issue beyond the original four: `computeReputation` was recomputing `baseTrust` per *receipt* instead of per *unique counterparty*, meaning the public, unauthenticated `GET /agents/:id/reputation` endpoint was an O(receipts) D1-read-amplification vector free to trigger. Fixed with a memoization cache in both `worker/src/reputationService.ts` and `src/services/reputationService.ts`. Also confirmed: `npm audit --omit=dev` is clean in both projects (the earlier vitest/esbuild advisories are dev-only, not shipped).
7. **Worker tests wired into a real suite** — `worker/tests/api.test.ts`, using Cloudflare's official `@cloudflare/vitest-plugin` (runs actual Worker code against simulated D1/KV/RateLimit bindings, no live server needed). 11 assertion-based tests, including a dedicated regression test for the race-condition fix (two concurrent countersign attempts on the same draft — asserts exactly one succeeds). `worker-smoke-test.ts` still exists separately and is still useful — it's a manual post-deploy sanity check against a *live* URL (local or production), which the vitest suite (Miniflare-only) can't be.

Current automated coverage: 14 Node vitest tests + 12 Python pytest tests + 11 Worker vitest tests = 37 automated tests, plus the manual smoke-test script and the cross-language demo script for live-deployment checks.

## What's actually done and verified (carried over)

- **SPEC.md** — v0.1 protocol specification. Not yet updated to mention the Worker deployment or Phase 1 hardening details — worth a pass before Phase 2's "SPEC cleanup" step.
- **Python SDK** (`sdk-python/`) — full parity with the TS `InamClient`, cross-language correctness proven both by fixed test vectors and a live two-language demo.
- **Cloudflare Workers deployment** — live at `https://api.inamprotocol.org` (custom domain, bound 2026-08-22; the workers.dev URL still works too as a fallback but is no longer the documented one).
- **Local git repo** at `C:\Users\User\Desktop\inam-protocol` (moved here from `C:\Users\User\inam-protocol` on 2026-08-22). **Still not pushed anywhere** — no GitHub remote configured. This commit (Phase 1 hardening) has not yet been made at the time of writing this file; see git log for the actual current commit count.

## Remaining known gaps (deliberately not Phase 1's job)

- No CI (GitHub Actions) — moot until pushed.
- Python SDK not published to PyPI.
- `inamprotocol.com` custom domain: zone not yet added to the Cloudflare account (needs the user to do a registrar nameserver change; the wrangler token here is zone:read only anyway, can't create the zone itself).
- GitHub repo not created/pushed — **user has not yet confirmed public vs. private visibility for it; ask before creating/pushing.**
- **Biggest strategic gap, not a coding task:** the "independent of big players" thesis has no institutional/governance reality yet — the whole system runs in one person's Cloudflare account. Real fix needs a strategy conversation (multi-region deploy, data export/backup story, eventual foundation/governance model), not code.
- Everything Phase 2+ per the phase list at the top of this file (Job API, verified external identity, payments/stake, marketplace) — deliberately deferred, not gaps.

## Next action

Moving into **Phase 2 — Public protocol**: SPEC.md cleanup/update, API docs, SDK polish/examples, versioning discipline. GitHub creation/push is part of Phase 2 per the agreed phase list, but blocked on the user answering public-vs-private.
