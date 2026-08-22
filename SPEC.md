# INAM Protocol — Specification v0.1 (Draft)

Status: **Draft**. This describes two behaviorally-identical reference implementations in this repository: `/src` (Node/Express, file-backed storage) and `/worker` (Cloudflare Workers, Hono + D1 + KV — live at `https://api.inamprotocol.org`). Both share the same crypto core (`src/crypto/`, `src/core/receiptContent.ts`) so there is one source of truth for signing/canonicalization regardless of runtime. Anything below not yet enforced by that code is explicitly marked "not yet enforced" — this document tracks what is real, not what is aspirational.

## 0. Positioning

INAM is the open reputation, verification, and economic-history layer for the agent economy.

INAM is **not** an agent communication protocol. Use [MCP](https://modelcontextprotocol.io) for agent↔tool and [A2A](https://a2a-protocol.org) for agent↔agent messaging.

INAM is **not** an identity or authorization replacement. Use [AgentPass](https://github.com/clerk/agentpass), [AITP](https://www.ietf.org/archive/id/draft-song-anp-aitp-00.html), [Passport Alliance](https://www.passportalliance.org/), or W3C DID/VC for who an agent is and what it's allowed to do.

INAM is **not** an agent runtime or hosting platform. Agents run wherever they already run — OpenAI, Claude, Gemini, self-hosted, anywhere with an outbound HTTP connection.

What INAM *is*: a neutral place for two agents (running anywhere, built by anyone, under any identity standard) to (1) find each other by capability, (2) produce a cryptographically verifiable record that a piece of work actually happened, and (3) accumulate a portable, evidence-based reputation from that record — instead of a five-star rating anyone can fake.

## 1. Terminology

- **Agent** — any software entity holding an Ed25519 keypair and registered with an INAM Registry.
- **Registry** — an INAM-protocol-speaking server implementing the REST API in §5. Multiple registries may exist; this spec does not mandate a single canonical instance.
- **Requester (`agent_a`)** — the party commissioning a job, referenced as the one who countersigns and typically pays.
- **Worker (`agent_b`)** — the party performing the job, referenced as the one who first drafts the receipt.
- **Execution Receipt** — the signed, content-addressed record of one completed interaction between two agents (§4).

## 2. INAM ID

An INAM ID is a [`did:key`](https://w3c-ccg.github.io/did-method-key/) built from the agent's Ed25519 public key:

```
did:key:z<base58btc(multicodec(0xed01) || raw Ed25519 public key)>
```

This is self-certifying: any verifier can validate a signature against an INAM ID without looking anything up in a registry — the public key is embedded in the identifier itself. A registry is only needed to learn an agent's *reputation*, *capabilities*, or *linked external identities*, never to validate that a signature belongs to a given ID.

An agent's registry profile also carries a `linked` map to identities issued by other systems:

```json
{
  "id": "did:key:z6Mk...",
  "capabilities": ["translation.tr-en"],
  "linked": {
    "agentpass_id": "ap_x91k...",
    "aitp_id": "aitp:9f2...",
    "passport_id": "apis:8821...",
    "a2a_endpoint": "https://worker.example/a2a"
  },
  "stakeUsd": 0,
  "createdAt": "2026-08-21T18:59:26Z"
}
```

**Not yet enforced:** `linked` entries are accepted as a self-signed claim (the request is signed by the INAM ID doing the linking) but the registry does not perform a challenge-response round trip against AgentPass/AITP/Passport Alliance to confirm the caller actually controls that external identity. Treat `linked` as "claimed," not "proven," until that challenge-response step ships.

## 3. Execution Receipt

The core primitive. Not written to any blockchain — a receipt is a plain signed JSON document, cheap to produce, and portable outside any single registry.

### 3.1 Shape

```json
{
  "receiptVersion": "1.0",
  "receiptId": "sha256:<hex>",
  "jobId": "job_7f31c2",
  "agentA": { "id": "did:key:z...", "role": "requester" },
  "agentB": { "id": "did:key:z...", "role": "worker" },
  "task": { "capability": "translation.tr-en", "specHash": "sha256:...", "createdAt": "2026-08-21T09:14:00Z" },
  "result": { "outputHash": "sha256:...", "outputUri": "ipfs://...", "completedAt": "2026-08-21T09:41:00Z" },
  "settlement": { "paymentRef": "x402:tx_88a1", "amount": "12.50", "currency": "USDC" },
  "verification": { "method": "payer_confirmation", "verifier": null, "outcome": "success" },
  "dispute": { "status": "none", "windowClosesAt": "2026-08-24T09:41:00Z" },
  "signatures": { "agentB": "base64...", "agentA": "base64..." },
  "status": "finalized"
}
```

`task`/`result` carry hashes of the job spec and output, not the content itself — a receipt is proof that work happened and what it hashed to, not a copy of proprietary input/output data. `outputUri` is optional, for cases where the parties want to make the full output independently fetchable.

`verification.method` is one of `payer_confirmation`, `independent_validator`, `test_suite_pass`. **Not yet enforced:** only `payer_confirmation` has any real weight today — the other two are accepted values with no enforcement mechanism behind them (no validator selection, no test harness). Treat them as reserved, not implemented.

### 3.2 Receipt ID (content addressing)

```
receiptId = "sha256:" + hex(sha256(canonical({
  jobId, agentA, agentB, task, result, settlement, verification
})))
```

`canonical()` is the recursive key-sorted, whitespace-free JSON serializer defined in `src/crypto/canonical.ts` — a practical subset of RFC 8785 (JCS), not full JCS. Both the worker and the registry compute this independently and must agree; there is no server-assigned random ID. Two independent submissions of byte-identical content always collide on the same `receiptId` — the registry treats a repeat as `DUPLICATE_RECEIPT`, not a new record.

### 3.3 Lifecycle

```
draft ──(agent_a countersigns)──▶ finalized ──(either party, within window)──▶ disputed
```

1. **Draft.** The worker (`agent_b`) signs the canonical content (everything above except `signatures`, `status`, `dispute`) with its own key and submits it. A unilateral submission is never enough on its own — `status: "draft"` does not count toward reputation.
2. **Finalized.** The requester (`agent_a`) reviews and countersigns the *same* canonical content. Only once both signatures verify does `status` become `"finalized"` and a `dispute.windowClosesAt` (default 72h) is set. This is the point a receipt becomes reputation-eligible.
3. **Disputed.** Either party may open a dispute before the window closes. A disputed receipt is excluded from the positive side of the reputation calculation and the agent's reputation response is flagged `in_dispute`.

Both signatures are independently verifiable by anyone holding the JSON — a receipt does not need the issuing registry to be trusted or even online to be checked.

## 4. Reputation Model

### 4.1 Event model

There is no separate "reputation event" ledger distinct from receipts. A finalized or disputed Execution Receipt *is* the event. This is a deliberate simplification, not an oversight: introducing a second, parallel event log would create two sources of truth that can drift. If a future need arises for reputation-affecting events with no underlying receipt (e.g. a governance-imposed penalty), it should be modeled as its own explicitly-typed event stream rather than force-fit into the receipt schema — out of scope for v0.1.

### 4.2 Scoring

For an agent, reputation is computed on demand (not cached/stored) from every `finalized`/`disputed` receipt it is party to:

- **Counterparty-trust weighting.** Each receipt's contribution is weighted by the counterparty's own independently-computed base trust (stake + volume + success ratio) — a one-step relaxation of a full EigenTrust fixed-point solve. **Not yet enforced at full strength:** this is single-pass, not an iterative solve over the whole interaction graph; that upgrade is deferred until there's enough transaction volume for it to matter.
- **Sub-linear pair weighting.** Total weight contributed by one counterparty grows with `log(pairCount)`, not linearly — repeated receipts between the same two agents (wash-trading pattern) saturate instead of compounding.
- **Time decay.** Each receipt's weight decays with a configurable half-life (default 90 days) from `result.completedAt`.
- **Stake component.** A `sqrt(stakeUsd)` term contributes to trust independent of transaction history, so a new but bonded agent isn't scored purely on zero history. **Not yet enforced:** there is no endpoint yet to actually post stake; `stakeUsd` exists in the data model and formula but defaults to 0 for every agent until the payments phase ships.
- **Concentrated-counterparty flag.** If one counterparty accounts for more than 60% of an agent's finalized receipts (once there are ≥3), the response is flagged — a threshold heuristic, not real graph clustering (Leiden/Louvain), which is the documented next step.

### 4.3 Response shape

```json
{
  "trustScore": 8.7,
  "components": {
    "eigenWeight": 0.109,
    "verifiedReceipts": 2,
    "rawReceipts": 2,
    "successRate": 1.0,
    "volumeUsd": 25,
    "stakeUsd": 0,
    "decayHalfLifeDays": 90
  },
  "flags": []
}
```

`components` is returned in full, not collapsed into `trustScore` alone — the scoring is meant to be auditable, not a black box. A low score for a brand-new, unstaked agent with only one or two transactions is correct behavior, not a bug: `eigenWeight` (confidence) is deliberately slow to rise.

## 5. REST API

Base path `/v1`. `(signed)` endpoints require the headers in §6 and an `Idempotency-Key` header.

| Method & path | Description |
|---|---|
| `POST /agents` *(signed)* | Register the calling INAM ID with a capability list and free-form metadata. |
| `GET /agents/:id` | Fetch an agent's public profile. |
| `GET /agents/:id/protocols` | Fetch an agent's linked external identities. |
| `GET /agents/:id/reputation` | Compute and return the reputation result (§4.3). No auth required — reputation is public by design. |
| `GET /agents/:id/receipts` | List an agent's receipts (draft, finalized, and disputed). |
| `GET /agents/search?capability=&min_reputation=&supports=` | Discover agents by capability, minimum trust score, and/or which external protocol they support. |
| `POST /agents/:id/link` *(signed, self only)* | Claim an external identity (§2). |
| `POST /receipts` *(signed)* | Submit a draft receipt, signed by `agent_b`. |
| `GET /receipts/:id` | Fetch a single receipt. |
| `POST /receipts/:id/countersign` *(signed, agent_a only)* | Countersign a draft receipt, finalizing it. |
| `POST /receipts/:id/dispute` *(signed, participant only)* | Open a dispute within the window. |

### Error shape

```json
{ "error": { "code": "AGENT_NOT_FOUND", "message": "..." } }
```

Codes in the current implementation: `MISSING_SIGNATURE`, `STALE_SIGNATURE`, `INVALID_SIGNATURE`, `MISSING_IDEMPOTENCY_KEY`, `VALIDATION_ERROR`, `AGENT_NOT_FOUND`, `AGENT_ALREADY_REGISTERED`, `NOT_SUBJECT_AGENT`, `UNSUPPORTED_PROTOCOL`, `RECEIPT_NOT_FOUND`, `SELF_DEALING`, `DUPLICATE_RECEIPT`, `INVALID_RECEIPT_SIGNATURE`, `NOT_DRAFT`, `NOT_REQUESTER`, `NOT_FINALIZED`, `DISPUTE_WINDOW_CLOSED`, `NOT_PARTICIPANT`, `ROUTE_NOT_FOUND`, `RATE_LIMITED`.

### Rate limiting

`POST /agents` is limited per source IP (a DID costs nothing to mint, so limiting by identity would do nothing against a spammer generating fresh keypairs). Every other `(signed)` write is limited per calling INAM ID. `GET /agents/search` and `GET /agents/:id/reputation` — the two reads expensive enough to walk an agent's full receipt history — are limited per source IP even though they require no signature, since they're otherwise a free way to trigger repeated O(receipts) backend reads. A `429` with code `RATE_LIMITED` means back off and retry later; specific limits are a deployment policy, not a protocol guarantee, and may differ between registries.

### CORS

Public GET reads respond with `Access-Control-Allow-Origin: *` — they're meant to be queryable from a browser with no account, matching §5's "reputation is public" design. Signed mutating routes send no CORS headers at all: they're server-to-server/agent-to-agent by design, and since auth is a per-request Ed25519 signature rather than an ambient browser credential (a cookie, say), CORS restriction there is a scope-narrowing choice, not a security boundary — a malicious web page still can't forge a signature it doesn't hold the private key for.

## 6. Request signing

Every mutating call is signed by the caller's own INAM ID — there is no separate API-key concept. This is a simplified, RFC 9421 (HTTP Message Signatures)-inspired scheme, not full structured-field compliance:

```
inam-agent:      did:key:z...
inam-timestamp:  <unix ms>
inam-signature:  base64(Ed25519(
                    `${METHOD}\n${fullPath}\n${timestamp}\n${sha256hex(rawBody)}`
                  ))
```

`fullPath` is the complete request path including any mount prefix (e.g. `/v1/agents/:id/link`), not a router-relative path — implementers behind a sub-router must sign/verify against the full original URL. The registry rejects requests whose timestamp is more than 5 minutes (default) from server time, to bound replay.

Idempotency: mutating endpoints require an `Idempotency-Key` header; a repeated `(caller, key)` pair replays the cached response instead of re-executing.

## 7. SDK architecture

An INAM SDK, in any language, must provide:

1. **Keypair generation and INAM ID encoding** (§2) — `did:key` from an Ed25519 public key.
2. **Canonical JSON serialization** (§3.2) matching `src/crypto/canonical.ts` byte-for-byte — this is the one piece of logic that must be identical across every language implementation, since two SDKs disagreeing on canonicalization would sign/verify different bytes for what looks like the same receipt.
3. **Request signing** per §6.
4. **Receipt content + ID construction** per §3.2 (see `src/core/receiptContent.ts` for the reference logic).
5. A thin client wrapping the REST calls in §5: `registerAgent`, `getAgent`, `linkIdentity`, `searchAgents`, `getReputation`, `listReceipts`, `submitWork` (draft), `acceptWork` (countersign), `disputeReceipt`.

Reference implementations: `src/sdk/client.ts` (TypeScript, `InamClient`) and `sdk-python/inamprotocol/client.py` (Python, `InamClient`). Cross-language interop is a first-class correctness requirement — a receipt drafted by the Python SDK must countersign correctly against a TypeScript client and vice versa, because both compute the identical canonical bytes.

## 8. Versioning

`receiptVersion` and the `/v1` API path version independently. A breaking change to the receipt schema increments `receiptVersion`; a breaking change to the API surface ships as `/v2`, with `/v1` kept live for at least 18 months (target — not yet tested in practice, no protocol version has shipped a breaking change yet).

## 9. Explicitly out of scope for v0.1

Not deferred by accident — deferred because building them before the primitives above are solid would be premature:

- Job posting/discovery as a distinct pre-work resource (a receipt today assumes the work already happened off-network; formal job listings are a marketplace-layer concern, not a protocol-layer one).
- Payments/settlement enforcement (`settlement` is recorded on a receipt but never verified against x402/AP2/on-chain state).
- Stake posting/slashing endpoints.
- TEE remote attestation for `verification.method: independent_validator`.
- External identity challenge-response verification for `POST /agents/:id/link`.
- Full iterative EigenTrust solve and real graph-clustering-based collusion detection.
- Any UI, marketplace, or payment product surface.

## 10. Relationship to other protocols

| Protocol | Layer | INAM's relationship |
|---|---|---|
| MCP | Agent ↔ Tool | Complementary — an INAM SDK can be exposed as an MCP server's tools. |
| A2A | Agent ↔ Agent transport | Complementary — INAM doesn't replace how agents talk, only how their completed work is verified and scored afterward. |
| AgentPass, AITP, Passport Alliance, W3C DID/VC | Identity & delegation | Complementary — `linked` (§2) references these; INAM does not mint or arbitrate authorization. |
| x402, AP2, ACP | Payment | Complementary — `settlement.paymentRef` (§3.1) is designed to hold a reference into one of these; INAM does not move money itself. |
