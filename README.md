# Inam Protocol Registry

The open reputation, verification, and economic-history layer for the agent economy. INAM is not an agent communication protocol (that's MCP/A2A), not an identity or authorization replacement (that's AgentPass/AITP/Passport Alliance/DID), and not an agent runtime — it's the neutral record of "this work actually happened between these two agents, and here's their evidence-based track record." Full specification: [`SPEC.md`](./SPEC.md).

This directory is the Node/TypeScript reference implementation: Express registry server, `did:key` identity, sybil-resistant reputation engine, and the `InamClient` SDK. A parity Python SDK lives in [`sdk-python/`](./sdk-python). Node 22 — zero native dependencies (pure-JS crypto and a file-backed store), so `npm install` never needs a C++ toolchain.

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

## What's here

- `src/crypto/` — `did:key` (Ed25519) encode/decode, signing/verification, a JCS-subset canonical JSON serializer.
- `src/middleware/signedRequest.ts` — request auth: every mutating call is signed by the caller's own key, not an API key. Simplified, RFC 9421-inspired scheme (see the file's doc comment for the exact header contract and why it isn't full RFC 9421 compliance).
- `src/services/receiptService.ts` — the Execution Receipt lifecycle: content-addressed IDs, draft → countersign → finalized, dispute window.
- `src/services/reputationService.ts` — the sybil-resistant scoring engine: counterparty-trust weighting, sub-linear pair weighting (wash-trading resistance), time decay, stake component, concentrated-counterparty flag.
- `src/core/receiptContent.ts` — the one piece of logic every SDK, in any language, must agree on byte-for-byte: receipt content shape and content-addressed ID computation. Shared by the server (`receiptService.ts`) and the TS SDK; the Python SDK has its own line-for-line port (`sdk-python/inamprotocol/receipt.py`).
- `src/sdk/client.ts` — `InamClient`, the seed of the future `@inamprotocol/agent-sdk` package. An agent framework's tool-calling layer would wrap these same calls as `search_jobs` / `verify_agent` / `submit_work` tools.
- `sdk-python/` — parity Python SDK (`InamClient`), with its own test suite including the cross-language interop check described above.
- `scripts/demo.ts` — a runnable two-agent scenario using the SDK client against a live server.
- `scripts/interop-phase-*.ts` + `sdk-python/examples/interop_worker.py` — the cross-language demo's three phases (see `scripts/run-interop-demo.sh` to run all of them together).

## API surface (`/v1`)

```
POST /agents                     register (signed)
GET  /agents/:id
GET  /agents/:id/protocols
GET  /agents/:id/reputation
GET  /agents/:id/receipts
GET  /agents/search?capability=&min_reputation=&supports=
POST /agents/:id/link            (signed)

POST /receipts                    submit draft, agent_b's signature (signed)
GET  /receipts/:id
POST /receipts/:id/countersign    agent_a's signature (signed)
POST /receipts/:id/dispute        (signed)
```

`(signed)` = requires `inam-agent` / `inam-timestamp` / `inam-signature` headers and an `Idempotency-Key` header.

## Deliberate simplifications — and the upgrade path for each

This is a reference implementation, not a production deployment. Every simplification below is a known, documented gap, not an oversight:

- **Storage**: a JSON file behind an in-memory `Map` (`src/storage/jsonStore.ts`), single-process only. Swap point: implement the same `get/set/all` interface against Postgres/SQLite; nothing above that layer changes.
- **Request signing**: a simplified scheme inspired by RFC 9421 / Web Bot Auth, not the full structured-field spec. Fine for this reference server; a production one should adopt a compliant library once one matures for Node.
- **External identity linking** (`POST /agents/:id/link`): accepts a self-signed claim that the caller controls the given AgentPass/AITP/Passport Alliance identity. It does **not** yet call out to those systems for a challenge-response proof of control — that's the next real increment before `link` can be trusted for anything high-stakes.
- **Reputation math**: a single-pass weighted score using each counterparty's independently-computed `baseTrust` as a one-step relaxation, not a full iterative EigenTrust fixed-point solve over the whole interaction graph. The concentrated-counterparty check is a threshold heuristic, not real graph clustering (Leiden/Louvain). Both are the documented seed of the fuller sybil-resistance design; they need real transaction volume to be worth the extra complexity.
- **Verification method**: `payer_confirmation` is the only one actually meaningful today — `independent_validator` and `test_suite_pass` are accepted values with no enforcement behind them yet.
- **Stake**: `stakeUsd` exists in the data model and feeds the reputation formula, but there's no endpoint to actually post or slash a stake — that arrives with the payments phase (x402/AP2 bridge), intentionally out of scope here.
- **Idempotency cache**: in-memory, resets on restart, not shared across instances.

## Reading the demo output

With two brand-new agents (zero stake, no prior history), two jobs is not supposed to produce a high trust score — the `confidence` term (`components.eigenWeight`) is deliberately low until real weighted history accumulates. A score that shot up after two transactions between unknown counterparties would mean the sybil resistance isn't working.
