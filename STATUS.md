# Status / Where We Left Off

Last updated: 2026-08-22. This file exists so a new session (human or Claude) can pick up exactly where the last one stopped, without re-deriving it from chat history.

Phase structure adopted (per user + external ChatGPT review of this codebase): **Phase 1 — Hardening** (done) → **Phase 2 — Public protocol** (done) → **Phase 3 — real cross-agent job workflow** (done) → **Phase 4 — verified external identity** (done, this update) → Phase 5 — economic layer (payments/stake) → Phase 6 — network/marketplace.

A second technical track was proposed by the user (relaying an external design sketch) immediately after Phase 4 landed: an **INAM Verification + Attestation layer** — a third-party (or deterministic) verifier attesting that a Provider's work actually meets a Job's requirements, sitting between Job/Receipt and Reputation. Not started yet; see "Open threads" below — this needs to be scoped down to a real first increment before implementation starts, not built as the full 20-section design in one pass.

## Done and verified

- **GitHub**: public org `inamprotocol`, public repo `inamprotocol/inam-protocol`, pushed and current.
- **Domain**: `inamprotocol.org` root is now **live** — a real content-first landing page (GNU/npm/PyPI-inspired information architecture, Public Sans + IBM Plex Mono, oxblood/seal accent) deployed as a Cloudflare Worker (`site/`), built end-to-end by a background agent and verified via direct fetch. `api.inamprotocol.org` and `docs.inamprotocol.org` remain live on their own Workers.
- **Job resource (SPEC.md §3)** — post → offer → accept → complete/cancel. Implemented and tested in all three runtimes.
- **`sdk-js/`** — the crypto/canonicalization/receipt-content/`InamClient` code, extracted into its own package. **Live on npm as `inamprotocol@0.2.0`** (bumped this update for the P-256 + link-challenge additions).
- **`sdk-python/`** — parity Python SDK. **Live on PyPI as `inamprotocol@0.3.0`** (bumped this update). Both SDKs installable: `npm install inamprotocol` / `pip install inamprotocol`.
- **External-identity link challenges (SPEC.md §2.1, Phase 4)** — `agentpass_id`/`aitp_id`/`passport_id` now require proof of control of the claimed external key (Ed25519 or P-256) via a single-use ~60s signed challenge, before a registry stores the link. Wire format aligned with ATTP (`draft-sharif-attp-00`, the protocol AgentPass is built on — real, IETF-drafted, confirmed via research before building against it). `a2a_endpoint` is unaffected (not a key-derived identity). Implemented in all three runtimes:
  - Node: in-memory challenge store (`src/storage/db.ts`'s `linkChallenges` Map), `agentService.ts`'s `requestLinkChallenge`/`completeLink`/`linkEndpoint`.
  - Worker: new D1 table `link_challenges` (not KV — chosen specifically so consuming a challenge can use the same compare-and-swap discipline, `UPDATE ... WHERE used = 0` + `meta.changes` check, already used for receipts/jobs, rather than a weaker guarantee).
  - Both SDKs: `requestLinkChallenge`/`request_link_challenge` + `completeLink`/`complete_link`, plus a new P-256 crypto module in each (`sdk-js/src/crypto/p256.ts`, `sdk-python/inamprotocol/p256.py`).
  - **Real cross-language bug found and fixed**: `cryptography`'s (Python) raw ECDSA P-256 signing doesn't normalize the S value, but `@noble/curves` (TypeScript/Worker) rejects non-canonical "high-S" signatures by default — so Python-produced P-256 signatures verified only ~50% of the time against the TS/Worker side. Fixed by canonicalizing to low-S in `p256_sign`; caught by running the cross-language demo repeatedly, not a single passing run. A dedicated 64-iteration regression test guards against recurrence.
  - Deployed live: D1 migration applied to production (`link_challenges` table, additive), Worker deployed, both the existing smoke-test suite and the new `scripts/link-challenge-smoke-test.ts` re-verified green against `https://api.inamprotocol.org`.
- Test coverage: 28 Node vitest + 21 Worker vitest + 19 Python pytest = **68 automated tests**, all green. Plus the live cross-language interop demo, `demo.ts`, and both smoke-test scripts — all re-run against production after this change (two now-outdated call sites, `scripts/demo.ts` and `sdk-python/examples/interop_worker.py`, were still using the old unchecked `link_identity("agentpass_id", ...)` call and had to be updated to the new challenge flow — a real regression the full re-run caught).

## Open threads

- **INAM Verification + Attestation layer** (next big technical step, per the user + an external design sketch they relayed): Provider submits a result → a Verifier (deterministic test, another agent, or human) attests it meets the Job's requirements → attestation feeds Reputation, sitting alongside (not replacing) the existing Job → Receipt → Reputation chain. The relayed design proposes a large v0.1 surface (verification_requests/attestations/disputes tables, multi-verifier consensus, external_attestation passthrough for OpenWork/AgentPass/etc., a whole new canonical signing payload). **Needs scoping down to a real, fully-shippable first increment** before implementation starts — same "eksiksiz yap" discipline as Job and the link-challenge work: build one true vertical slice (e.g. single deterministic verifier + attestation + reputation hook, Node-only first) completely and tested, rather than all three runtimes × the full 20-section design at once.
- **Root domain color/design**: resolved this update (see "Done and verified") — no longer open.
- **OpenWork.network**: researched properly (not just taken at the earlier pasted analysis's word) — its GitHub org (`OpenWorkNetwork`) has **zero public repositories**; the design proposal's "closest real competitor" framing undersold how much more open INAM actually is in practice. Positioning conclusion unchanged: don't compete on marketplace/economy, position INAM as the neutral layer systems like OpenWork could plug into — but the evidence for that framing is now solid, not assumed. Not yet written into README's "relationship to other protocols" section.
- **Phase 5+ (payments/stake, marketplace)**: not started, deliberately.

## Next action

Scope and start the Verification/Attestation layer as a properly-sized first increment — needs a scoping conversation with the user before writing code, since the relayed design is large and this project's standing instruction is "no half-finished work." Alternatively: write the OpenWork positioning into README §11.
