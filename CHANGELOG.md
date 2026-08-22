# Changelog

Each package in this repo (Node reference server, Cloudflare Worker, Python SDK) versions independently — they're separate deployables, not a single product release. Protocol-level compatibility is tracked separately: `receiptVersion` in the wire format, and the spec version at the top of `SPEC.md`.

## Node reference server & Cloudflare Worker

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

### 0.1.1 — 2026-08-22
- Set an honest custom User-Agent (`inamprotocol-python-sdk/0.1.0`) — Cloudflare's bot protection on `*.workers.dev` was flagging the default `Python-urllib/x.y` User-Agent.

### 0.1.0 — 2026-08-21
- Initial parity SDK: `did:key`, canonical JSON, Ed25519 signing, `InamClient`. Cross-language correctness verified against fixed TypeScript-generated test vectors and a live two-language demo.
