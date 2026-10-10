<img src="site/public/logo.svg" width="64" height="64" alt="INAM Protocol logo">

# Inam Protocol Registry

[![npm](https://img.shields.io/npm/v/inamprotocol?label=npm%20inamprotocol)](https://www.npmjs.com/package/inamprotocol)
[![PyPI](https://img.shields.io/pypi/v/inamprotocol?label=pypi%20inamprotocol)](https://pypi.org/project/inamprotocol/)
[![npm](https://img.shields.io/npm/v/inam-mcp?label=npm%20inam-mcp)](https://www.npmjs.com/package/inam-mcp)
[![CI](https://github.com/inamprotocol/inam-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/inamprotocol/inam-protocol/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

**Your agent checks who it is paying before it pays.** An x402 payment only goes out if the payee's INAM ID proved control of the `payTo` wallet *and* has work that a real counterparty countersigned. A server that borrows a reputable agent's ID to collect the money gets nothing.

<img src="site/public/x402-demo.svg" width="880" alt="npm run demo:x402: the honest seller is paid; an endpoint borrowing the seller's INAM ID with someone else's wallet is blocked; a newcomer with no work history is blocked">

Try it (one command, local, no real money, no signup):

```
git clone https://github.com/inamprotocol/inam-protocol && cd inam-protocol
npm install && npm --prefix sdk-js install
npm run demo:x402
```

**Give your own agent an identity and its first countersigned receipt, in about a minute**, against the live registry. The registry's demo agent is the other party (SPEC [§14](./SPEC.md#14-hosted-demo-counterparty-v040); demo receipts never count toward reputation):

```
npm i inamprotocol
curl -sO https://raw.githubusercontent.com/inamprotocol/inam-protocol/main/examples/quickstart.mjs && node quickstart.mjs
```

The key is saved to `./inam-agent.key` and reused on later runs; that keypair *is* your agent's identity (a `did:key`), there is no signup.

Check any agent's reputation, no install and no key (this is a maintainer-run reference agent):

```
curl -s https://api.inamprotocol.org/v1/agents/did:key:z6MkjE6iZEFoKkBoxR3QygfWaFUkLUUkj1ry527tUWQB8Gpk/reputation
```

`evidenceLevel` says how much to believe `trustScore`: `none`, `countersigned` (both parties signed), or `independently_verified`. Browse agents in the [explorer](https://explorer.inamprotocol.org).

In your own agent it is one wrapper around fetch: `withInamX402Gate(fetch, client, { minEvidence: "countersigned" })` (TypeScript SDK, [`examples/x402-verify-before-pay.ts`](./examples/x402-verify-before-pay.ts), SPEC [§11.2](./SPEC.md#112-x402-verify-before-paying-v036)). The thresholds are yours; `checkTrust()` gives the same allow / escrow / deny decision outside x402.

Underneath, INAM is an open record of agent work: both sides sign a receipt for every finished job, and reputation is computed only from those receipts. INAM is not an agent communication protocol (that's MCP/A2A), not an identity or authorization replacement (that's AgentPass/AITP/Passport Alliance/DID), and not an agent runtime — it's the neutral record of "this work actually happened between these two agents, and here's their evidence-based track record." Full specification: [`SPEC.md`](./SPEC.md), also readable at **[docs.inamprotocol.org](https://docs.inamprotocol.org)** alongside an interactive API reference generated from `openapi.yaml` (source in [`docs-site/`](./docs-site)).

## Why this exists

A 2026 empirical study of ERC-8004, the Ethereum agent-reputation standard ([arXiv 2606.26028](https://arxiv.org/abs/2606.26028)), found that 95–100% of its feedback was tied to no task and no payment, and that 59–91% of reviewers showed coordinated Sybil behavior. Its conclusion was that the registry "cannot function as a reliable trust signal." Anyone can post a score, so scores mean little.

INAM has no free-standing score to post. Every trust signal is built from evidence:

1. **Two-party signed receipts.** An agent's reputation comes only from Execution Receipts that *both* parties signed, each naming a job, a spec hash, and an output hash. The receipt ID is the hash of its content, so it can't be edited afterward.
2. **Sybil-discounted scoring.** Counterparties are weighted by their own trust, repeat pairs count sub-linearly, and old history decays. Throwaway identities vouching for each other don't move the score.
3. **Operator-authorized verifiers.** Independent attestations count only from verifiers the registry operator explicitly granted (no self-service). A `rejected` verdict scores as a failure. Every reputation reports its `evidenceLevel`: `none`, `countersigned`, or `independently_verified`. The maintainers run a [live integrity verifier](./scripts/integrity-verifier.ts) against the public registry every hour.
4. **Tamper-evident history.** Every finalized receipt is appended to an RFC 6962-style Merkle transparency log. An [external monitor](./scripts/sth-monitor.ts) checks each new tree head for consistency every hour, and its history is public on the [`monitor-state`](https://github.com/inamprotocol/inam-protocol/tree/monitor-state) branch.

INAM composes with ERC-8004 rather than competing with it at the identity layer: an ERC-8004 identity can be linked to an INAM ID with a standard wallet signature (SPEC [§11.1](./SPEC.md#111-inam-and-erc-8004)).

What these defences do not cover is listed in [`THREAT-MODEL.md`](./THREAT-MODEL.md). Who decides what, and what the public registry's operator commits to, is in [`GOVERNANCE.md`](./GOVERNANCE.md).

## This repository

This directory is the Node/TypeScript reference implementation: Express registry server, `did:key` identity, sybil-resistant reputation engine, and the `InamClient` SDK. The SDK itself is published standalone as [`inamprotocol`](https://www.npmjs.com/package/inamprotocol) (source in [`sdk-js/`](./sdk-js) — the exact code this server and the Worker deployment import, not a separate build). A parity Python SDK is published as [`inamprotocol`](https://pypi.org/project/inamprotocol/) on PyPI (source in [`sdk-python/`](./sdk-python)). Node 22 — zero native dependencies (pure-JS crypto and the built-in `node:sqlite` store), so `npm install` never needs a C++ toolchain.

## Run it

New here? Start with [`QUICKSTART.md`](./QUICKSTART.md) — zero to a real, changed reputation score in about two minutes, against the live registry.

### Self-host with Docker

```
git clone https://github.com/inamprotocol/inam-protocol && cd inam-protocol
docker compose up -d     # registry on http://localhost:4021, data in the inam-data volume
```

Point any SDK at `http://localhost:4021` instead of the live API. Set `INAM_OPERATOR_DID` (a `did:key`) in the environment before `up` if you want to grant verifier status (SPEC §12.3); left unset, nobody can. `docker compose down -v` wipes the data.

Running a private registry for your team's own agents (prebuilt image, backups, explorer, private receipts): [`SELF-HOSTING.md`](./SELF-HOSTING.md).

### From source

`sdk-js` is a separate nested package that this server imports directly by relative path (see "What's here" below), so it needs its own `npm install` too — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) if `npm run dev` fails with a missing-module error.

```
npm install
cd sdk-js && npm install && cd ..
npm run dev      # starts the API on http://localhost:4021
npm run demo     # in another terminal: registers two agents, links an external
                  # identity, runs two jobs end to end, prints the resulting
                  # reputation
npm test         # canonical-JSON, did:key/signing, and receipt-lifecycle tests
```

Data is persisted to `data/registry.db` (SQLite, gitignored). Delete that folder to reset the registry to empty. Tests never touch it — they run against a fresh temp directory (see `tests/setupEnv.ts`).

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

### From an AI agent (MCP / Claude Code)

Any MCP client can use the registry through [`inam-mcp`](https://www.npmjs.com/package/inam-mcp) (source in [`mcp/`](./mcp)):

```
claude mcp add inam -- npx -y inam-mcp
```

That starts read-only. To register and sign receipts as your agent, pass its key: `claude mcp add inam -e INAM_PRIVATE_KEY=$(cat inam-agent.key) -- npx -y inam-mcp` (the key file the quickstart above writes).

Or, read-only with nothing to install, point any Streamable HTTP MCP client at the hosted endpoint `https://api.inamprotocol.org/mcp` (`claude mcp add --transport http inam https://api.inamprotocol.org/mcp`).

In Claude Code, the INAM plugin bundles a skill that walks you through exploring the registry, running a demo job/receipt cycle, and registering an agent identity (details in [`inam-protocol-plugin/`](./inam-protocol-plugin)):

```
/plugin marketplace add inamprotocol/inam-protocol
/plugin install inam-protocol@inam-protocol-plugins
```

## What's here

- `sdk-js/` — the published `inamprotocol` npm package: `did:key` (Ed25519) encode/decode, signing/verification, the JCS-subset canonical JSON serializer, content-addressed receipt IDs, and `InamClient`. This server (`src/services/receiptService.ts`, `src/middleware/signedRequest.ts`) and the Cloudflare Worker (`worker/src/receiptService.ts`, `worker/src/signedRequest.ts`) import these files directly by relative path rather than depending on the built package — there is exactly one implementation of the crypto/canonicalization/receipt-content logic across every TypeScript runtime in this repo.
- `src/middleware/signedRequest.ts` — request auth: every mutating call is signed by the caller's own key, not an API key. Simplified, RFC 9421-inspired scheme (see the file's doc comment for the exact header contract and why it isn't full RFC 9421 compliance).
- `src/services/receiptService.ts` — the Execution Receipt lifecycle: content-addressed IDs, draft → countersign → finalized, dispute window.
- `src/services/jobService.ts` / `worker/src/jobService.ts` — the optional Job resource (SPEC.md §3): open → accepted → completed/cancelled, offers, and the consistency check tying a finalized receipt back to the job it completes. Implemented in both runtimes and both SDKs.
- `src/services/verificationService.ts` / `worker/src/verificationService.ts` — the Verification resource (SPEC.md §12): a single independent verifier's signed attestation that a finalized receipt's output satisfies its job's requirements, feeding a reputation weight boost. Implemented in both runtimes and both SDKs.
- `src/services/reputationService.ts` — the sybil-resistant scoring engine: counterparty-trust weighting, sub-linear pair weighting (wash-trading resistance), time decay, stake component, concentrated-counterparty flag, independent-verification boost.
- `src/services/badgeService.ts` / `worker/src/badgeService.ts` — the embeddable reputation badge (`GET /agents/:id/badge.svg` / `.json`): a rendering layer over `computeReputation()`'s output, not a second scoring engine. Never interpolates agent-supplied text (e.g. `metadata.name`) into the SVG — only the fixed "inam" label and a server-computed score/status.
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
GET  /agents/:id/badge.svg        embeddable shields.io-style trust-score badge (unsigned, public)
GET  /agents/:id/badge.json       same badge data as JSON, for a custom renderer
GET  /agents/:id/receipts
GET  /agents/search?capability=&min_reputation=&supports=&include_revoked=&include_demo=&limit=&offset=
POST /agents/:id/link/challenge   request a proof-of-control challenge (signed)
POST /agents/:id/link            (signed; agentpass_id/aitp_id/passport_id/erc8004_id require a completed challenge)
POST /agents/:id/revoke          one-way retire this INAM ID (signed, self)
POST /agents/:id/verifier-status grant/revoke verifier authorization (signed, operator only)

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
POST /receipts/:id/dispute/resolve  the opener withdraws it: disputed -> finalized (signed)

POST /verifications                independent attestation of a finalized receipt (signed)
GET  /verifications/:id

GET  /transparency/sth             current Merkle tree size + root hash
GET  /transparency/entries?limit=&offset=
GET  /transparency/proof/inclusion?leafIndex=&treeSize=
GET  /transparency/proof/consistency?first=&second=
```

`(signed)` = requires `inam-agent` / `inam-timestamp` / `inam-signature` headers and an `Idempotency-Key` header.

**Reputation badge**: drop an agent's live trust score into any project's README as an image, the same way CI/coverage badges work:

```md
![reputation](https://api.inamprotocol.org/v1/agents/<did>/badge.svg)
```

Read-only, unsigned, and open to any origin — no INAM account or API key needed to embed it. Color-coded (green ≥70, yellow ≥40, red below), with a distinct neutral grey badge for a brand-new agent with no receipt history yet (`new`) and for an unregistered `did:key` (`unknown`) — the latter still returns `200` with a valid image rather than a broken `<img>`. `/badge.json` returns the same data as shields.io's own "endpoint badge" JSON schema, for anyone who'd rather render their own badge (or point shields.io itself at the URL via `https://img.shields.io/endpoint?url=...`).

## Deliberate simplifications — and the upgrade path for each

This is a reference implementation, not a production deployment. Every simplification below is a known, documented gap, not an oversight:

- **Storage**: SQLite via the built-in `node:sqlite` (`src/storage/db.ts`), single-process. The live deployment uses Cloudflare D1. A multi-instance self-host would need a shared database behind the same queries.
- **Request signing**: a simplified scheme inspired by RFC 9421 / Web Bot Auth, bound to the target host (v2, SPEC §7), not the full structured-field spec. Fine for this reference server; a production one should adopt a compliant library once one matures for Node.
- **External identity linking** (`POST /agents/:id/link`): `agentpass_id`/`aitp_id`/`passport_id` now require a signed challenge proving control of the claimed external key (SPEC.md §2.1; wire format aligned with ATTP, the protocol AgentPass is built on) before the registry stores the link — no longer a bare self-signed claim. What it does **not** yet do: call out to AgentPass/AITP/Passport Alliance's own registries to confirm that key is still the one each system currently recognizes as authoritative (a rotated or revoked external key wouldn't be caught) — that live cross-registry resolution is the next real increment.
- **Reputation math**: a single-pass weighted score using each counterparty's independently-computed `baseTrust` as a one-step relaxation, not a full iterative EigenTrust fixed-point solve over the whole interaction graph. The concentrated-counterparty check is a threshold heuristic, not real graph clustering (Leiden/Louvain). Both are the documented seed of the fuller sybil-resistance design; they need real transaction volume to be worth the extra complexity.
- **Verification method**: `payer_confirmation` is a party's own claim, unenforced beyond the request signature. `independent_validator`/`test_suite_pass` now have a real backing mechanism — the Verification resource (SPEC.md §12: `POST /verifications`, a single independent verifier's signed attestation, `provider != verifier` enforced) — The one verifier running live today (`scripts/integrity-verifier.ts`) checks output *integrity* (the bytes at `outputUri` hash to `outputHash`), not correctness. The design is deliberately narrow (one verifier, no multi-verifier consensus, no human/external-registry attestation methods, no verifier-side reputation yet; see SPEC.md §12.7 for the full explicitly-deferred v0.2 backlog).
- **Stake**: `stakeUsd` exists in the data model and feeds the reputation formula, but there's no endpoint to actually post or slash a stake — that arrives with the payments phase (x402/AP2 bridge), intentionally out of scope here.
- **Idempotency cache**: in-memory, resets on restart, not shared across instances.

## Reading the demo output

With two brand-new agents (zero stake, no prior history), two jobs is not supposed to produce a high trust score — the `confidence` term (`components.eigenWeight`) is deliberately low until real weighted history accumulates. A score that shot up after two transactions between unknown counterparties would mean the sybil resistance isn't working.
