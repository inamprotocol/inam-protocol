# Status / Where We Left Off

Last updated: 2026-08-22. This file exists so a new session (human or Claude) can pick up exactly where the last one stopped, without re-deriving it from chat history.

Phase structure adopted (per user + external ChatGPT review of this codebase): **Phase 1 — Hardening** (done) → **Phase 2 — Public protocol** (GitHub, docs, SDK publishing, versioning — done) → **Phase 3 — real cross-agent job workflow** (done) → Phase 4 — verified external identity → Phase 5 — economic layer (payments/stake) → Phase 6 — network/marketplace.

## Done and verified

- **GitHub**: public org `inamprotocol`, public repo `inamprotocol/inam-protocol`, pushed and current.
- **Domain**: `inamprotocol.org` — mail (MX/DKIM/SPF) works; `api.inamprotocol.org` and `docs.inamprotocol.org` are live Cloudflare Workers custom domains. **The bare root domain has no A/AAAA/CNAME record and nothing deployed at it** — deliberately deferred (see "Open threads" below).
- **docs.inamprotocol.org** — rendered SPEC.md + Redoc API reference from `openapi.yaml`, built by a background agent, verified live.
- **Job resource (SPEC.md §3)** — post → offer → accept → complete/cancel, additive and backward-compatible. Implemented and tested in all three runtimes: Node (`src/services/jobService.ts`), Worker/D1 (`worker/src/jobService.ts`, offers in their own `job_offers` table to avoid a concurrent-offer race), and both SDKs.
- **`sdk-js/`** (new 2026-08-22) — the crypto/canonicalization/receipt-content/`InamClient` code, previously living inside `src/`, extracted into its own standalone package. **Published and live on npm as `inamprotocol@0.1.0`** (user ran `npm publish` themselves 2026-08-22; confirmed via the public registry, same shasum as the locally-verified tarball). The Node server and Worker still import this exact code by relative path (no behavior change, one source of truth preserved) — see `CHANGELOG.md`'s "TypeScript/JavaScript SDK" section.
- **`sdk-python/`** — parity Python SDK. Built, `twine check`-validated, and verified via a clean-venv install. **Not yet actually published to PyPI** — that step requires the user's own PyPI API token (credential-entry boundary); the user has registered a PyPI account but has not run `twine upload` yet.
- Test coverage: 20 Node vitest + 16 Worker vitest (incl. concurrent-accept/countersign race regression tests) + 12 Python pytest = 48 automated tests, all green as of this update. Plus the live cross-language interop demo (`scripts/run-interop-demo.sh`) and both smoke-test scripts, re-run and passing after the `sdk-js` extraction.

## Open threads

- **Root domain landing page** (`inamprotocol.org` bare domain): explicitly deferred by the user. A first design draft (university/open-source-library aesthetic, content-over-form) was rejected — "renklendirmeler üzerinde çalışmalısın özellikle" (work on the coloring specifically) — a redo focused on color is expected later, but protocol/engineering work takes priority until the user asks for it again.
- **Publish `sdk-python` to PyPI**: user needs to create a PyPI API token and run `cd sdk-python && python -m twine upload dist/*` themselves.
- **Phase 4+ (verified external identity, payments/stake, marketplace)**: not started. `POST /agents/:id/link` still only accepts a self-signed claim, no real challenge-response against AgentPass/AITP/Passport Alliance yet.
- **OpenWork.network**: identified as the closest thing to a real competitor (task/agent network with its own credentials, reputation, and reward economy). Current positioning response: don't compete on marketplace/economy — position INAM as the neutral trust/verification/reputation layer that systems like OpenWork (or A2A/MCP/Claude/OpenAI ecosystems) could each plug into via the SDK. Worth eventually writing this into README's "relationship to other protocols" section once the positioning is settled.

## Next action

Whichever the user picks next: PyPI publish (needs their own credentials — I can't do it), Phase 4 (verified identity), or the root-domain design redo. No default assumed — ask or take the most recently requested thread.
