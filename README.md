# Inam Protocol Registry

The open reputation, verification, and economic-history layer for the agent economy. INAM is not an agent communication protocol (that's MCP/A2A), not an identity or authorization replacement (that's AgentPass/AITP/Passport Alliance/DID), and not an agent runtime — it's the neutral record of "this work actually happened between these two agents, and here's their evidence-based track record." Full specification: [`SPEC.md`](./SPEC.md), also readable at **[docs.inamprotocol.org](https://docs.inamprotocol.org)** alongside an interactive API reference generated from `openapi.yaml` (source in [`docs-site/`](./docs-site)).

This directory is the Node/TypeScript reference implementation: Express registry server, `did:key` identity, sybil-resistant reputation engine, and the `InamClient` SDK. The SDK itself is published standalone as [`inamprotocol`](https://www.npmjs.com/package/inamprotocol) (source in [`sdk-js/`](./sdk-js) — the exact code this server and the Worker deployment import, not a separate build). A parity Python SDK is published as [`inamprotocol`](https://pypi.org/project/inamprotocol/) on PyPI (source in [`sdk-python/`](./sdk-python)). Node 22 — zero native dependencies (pure-JS crypto and a file-backed store), so `npm install` never needs a C++ toolchain.

## Run it

```
npm install
npm run dev      # starts the API on http://localhost:4021
npm run demo     # in another terminal: registers two agents, links an external
                  # identity, runs two jobs end to end, prints the resulting
                  # reputation
npm test         # canonical-JSON, did:key/signing, and receipt-lifecycle tests
```

Data is persisted to `data/*.json` (gitignored). Delete that folder to reset the registry to empty. Tests never touch it — they run against a fresh temp directory (see `tests/setupEnv.ts`).

### Cross-language interop demo

```
bash scripts/run-interop-demo.sh
```

Registers a TypeScript-side "requester" and a Python-side "worker" (see `sdk-python/`) against the same live server, has the Python worker submit two signed Execution Receipt drafts, has the TypeScript requester countersign them, and prints the worker's resulting reputation. This is the real end-to-end proof that the protocol — not just one SDK — works: the server verifies Python-produced Ed25519 signatures, and both SDKs agree byte-for-byte on canonical JSON. See `sdk-python/tests/test_interop.py` for the same guarantee as a fast, no-server-required unit test.

## Live deployment

`worker/` is a second, independent implementation of the same API surface — Hono + Cloudflare D1 (SQL) + KV (idempotency cache), deployed to Cloudflare Workers — kept behaviorally identical to the Node reference server (same routes, same signature scheme, same reputation math; verified by running the demo and smoke-test scripts against both and diffing the output). It reuses `sdk-js/src/crypto/` and `sdk-js/src/core/receiptContent.ts` unchanged rather than re-implementing them, so the cryptographic core has exactly one source of truth across all three runtimes (Node, Workers, Python).

Currently live at `https://api.inamprotocol.org` (custom domain, bound via `worker/wrangler.jsonc`; the `*.workers.dev` URL still works too as a fallback).

```
cd worker
npm install
npm run dev              # local dev server (D1 + KV emulated locally)
npm run deploy            # deploy to Cloudflare
npm run db:init:local     # apply schema.sql to the local D1 emulation
npm run db:init:remote    # apply schema.sql to the real remote D1 database
```

`scripts/worker-smoke-test.ts` (run with `INAM_URL` pointed at either a local `wrangler dev` instance or the live deployment) specifically exercises the parts that are new in this deployment rather than shared with the Node server: routing, D1 queries, and KV-backed idempotency — duplicate registration, self-dealing, duplicate receipts, wrong-signer rejection, idempotent replay, and the dispute flow.

## SDKs

```
npm install inamprotocol
```
```python
pip install inamprotocol
```

```ts
import { InamClient, generateKeypair } from "inamprotocol";

const client = new InamClient("https://api.inamprotocol.org", generateKeypair());
const profile = await client.registerAgent(["document-extraction"]);
```

See [`sdk-js/README.md`](./sdk-js/README.md) and [`sdk-python/README.md`](./sdk-python/README.md) for the full client surface (jobs, receipts, reputation).

## What's here

- `sdk-js/` — the published `inamprotocol` npm package: `did:key` (Ed25519) encode/decode, signing/verification, the JCS-subset canonical JSON serializer, content-addressed receipt IDs, and `InamClient`. This server (`src/services/receiptService.ts`, `src/middleware/signedRequest.ts`) and the Cloudflare Worker (`worker/src/receiptService.ts`, `worker/src/signedRequest.ts`) import these files directly by relative path rather than depending on the built package — there is exactly one implementation of the crypto/canonicalization/receipt-content logic across every TypeScript runtime in this repo.
- `src/middleware/signedRequest.ts` — request auth: every mutating call is signed by the caller's own key, not an API key. Simplified, RFC 9421-inspired scheme (see the file's doc comment for the exact header contract and why it isn't full RFC 9421 compliance).
- `src/services/receiptService.ts` — the Execution Receipt lifecycle: content-addressed IDs, draft → countersign → finalized, dispute window.
- `src/services/jobService.ts` / `worker/src/jobService.ts` — the optional Job resource (SPEC.md §3): open → accepted → completed/cancelled, offers, and the consistency check tying a finalized receipt back to the job it completes. Implemented in both runtimes and both SDKs.
- `src/services/verificationService.ts` / `worker/src/verificationService.ts` — the Verification resource (SPEC.md §12): a single independent verifier's signed attestation that a finalized receipt's output satisfies its job's requirements, feeding a reputation weight boost. Implemented in both runtimes and both SDKs.
- `src/services/reputationService.ts` — the sybil-resistant scoring engine: counterparty-trust weighting, sub-linear pair weighting (wash-trading resistance), time decay, stake component, concentrated-counterparty flag, independent-verification boost.
- `sdk-js/src/core/receiptContent.ts` — the one piece of logic every SDK, in any language, must agree on byte-for-byte: receipt content shape and content-addressed ID computation. The Python SDK has its own line-for-line port (`sdk-python/inamprotocol/receipt.py`), verified against fixed cross-language test vectors.
- `sdk-js/src/client.ts` — `InamClient`. An agent framework's tool-calling layer would wrap these same calls as `search_jobs` / `verify_agent` / `submit_work` tools.
- `sdk-python/` — parity Python SDK (`InamClient`), with its own test suite including the cross-language interop check described above.
- `scripts/demo.ts` — a runnable two-agent scenario using the SDK client against a live server.
- `scripts/interop-phase-*.ts` + `sdk-python/examples/interop_worker.py` — the cross-language demo's three phases (see `scripts/run-interop-demo.sh` to run all of them together).

## API surface (`/v1`)

Machine-readable spec: [`openapi.yaml`](./openapi.yaml) (validates clean with `npx @redocly/cli lint openapi.yaml`).

```
POST /agents                     register (signed)
GET  /agents/:id
GET  /agents/:id/protocols
GET  /agents/:id/reputation
GET  /agents/:id/receipts
GET  /agents/search?capability=&min_reputation=&supports=
POST /agents/:id/link/challenge   request a proof-of-control challenge (signed)
POST /agents/:id/link            (signed; agentpass_id/aitp_id/passport_id require a completed challenge)

POST /jobs                        post an open job (signed)
GET  /jobs/:id
GET  /jobs/search?capability=&status=
POST /jobs/:id/offers             (signed)
GET  /jobs/:id/offers
POST /jobs/:id/accept             poster only (signed)
POST /jobs/:id/cancel             poster only (signed)

POST /receipts                    submit draft, agent_b's signature (signed)
GET  /receipts/:id
GET  /receipts/:id/verifications
POST /receipts/:id/countersign    agent_a's signature (signed)
POST /receipts/:id/dispute        (signed)

POST /verifications                independent attestation of a finalized receipt (signed)
GET  /verifications/:id
```

`(signed)` = requires `inam-agent` / `inam-timestamp` / `inam-signature` headers and an `Idempotency-Key` header.

## Deliberate simplifications — and the upgrade path for each

This is a reference implementation, not a production deployment. Every simplification below is a known, documented gap, not an oversight:

- **Storage**: a JSON file behind an in-memory `Map` (`src/storage/jsonStore.ts`), single-process only. Swap point: implement the same `get/set/all` interface against Postgres/SQLite; nothing above that layer changes.
- **Request signing**: a simplified scheme inspired by RFC 9421 / Web Bot Auth, not the full structured-field spec. Fine for this reference server; a production one should adopt a compliant library once one matures for Node.
- **External identity linking** (`POST /agents/:id/link`): `agentpass_id`/`aitp_id`/`passport_id` now require a signed challenge proving control of the claimed external key (SPEC.md §2.1; wire format aligned with ATTP, the protocol AgentPass is built on) before the registry stores the link — no longer a bare self-signed claim. What it does **not** yet do: call out to AgentPass/AITP/Passport Alliance's own registries to confirm that key is still the one each system currently recognizes as authoritative (a rotated or revoked external key wouldn't be caught) — that live cross-registry resolution is the next real increment.
- **Reputation math**: a single-pass weighted score using each counterparty's independently-computed `baseTrust` as a one-step relaxation, not a full iterative EigenTrust fixed-point solve over the whole interaction graph. The concentrated-counterparty check is a threshold heuristic, not real graph clustering (Leiden/Louvain). Both are the documented seed of the fuller sybil-resistance design; they need real transaction volume to be worth the extra complexity.
- **Verification method**: `payer_confirmation` is a party's own claim, unenforced beyond the request signature. `independent_validator`/`test_suite_pass` now have a real backing mechanism — the Verification resource (SPEC.md §12: `POST /verifications`, a single independent verifier's signed attestation, `provider != verifier` enforced) — but it's deliberately narrow (one verifier, no multi-verifier consensus, no human/external-registry attestation methods, no verifier-side reputation yet; see `docs-design/verification-v0.2-backlog.md` for the sketched next increment).
- **Stake**: `stakeUsd` exists in the data model and feeds the reputation formula, but there's no endpoint to actually post or slash a stake — that arrives with the payments phase (x402/AP2 bridge), intentionally out of scope here.
- **Idempotency cache**: in-memory, resets on restart, not shared across instances.

## Reading the demo output

With two brand-new agents (zero stake, no prior history), two jobs is not supposed to produce a high trust score — the `confidence` term (`components.eigenWeight`) is deliberately low until real weighted history accumulates. A score that shot up after two transactions between unknown counterparties would mean the sybil resistance isn't working.
