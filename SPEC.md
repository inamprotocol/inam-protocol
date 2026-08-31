# INAM Protocol — Specification v0.15 (Draft)

Status: **Draft**. This describes two behaviorally-identical reference implementations in this repository: `/src` (Node/Express, file-backed storage) and `/worker` (Cloudflare Workers, Hono + D1 + KV — live at `https://api.inamprotocol.org`). Both share the same crypto core (`sdk-js/src/crypto/`, `sdk-js/src/core/receiptContent.ts` — published standalone as the `inamprotocol` npm package) so there is one source of truth for signing/canonicalization regardless of runtime. Anything below not yet enforced by that code is explicitly marked "not yet enforced" — this document tracks what is real, not what is aspirational.

**Changes from v0.14:** the same external audit found the job and dispute state machines incomplete. **(1) The dispute machine had a declared-but-unreachable state:** `dispute.status` was `"none" | "open" | "resolved"`, but nothing ever set `"resolved"` — a `disputed` receipt was a permanent dead end, excluded from reputation forever even if the dispute was frivolous, mistaken, or settled off-band. New **§4.3** exit: `POST /receipts/:id/dispute/resolve` *(signed, by the party that opened the dispute)* moves the receipt `disputed → finalized` and `dispute.status → "resolved"` (recording `resolvedAt` + optional `resolution`), so it counts toward reputation again and the `in_dispute` flag clears. Only the opener may do this (the disputed-against party clearing a dispute against itself would defeat the point), and only once — a resolved receipt can't be re-disputed (`DISPUTE_ALREADY_RESOLVED`). This is *not* arbitration; a third-party resolution authority stays out of scope (§10). `dispute` gains `openedBy` so the opener can be identified. **(2) `cancelled → completed` was reachable** in the Node reference: if a poster cancelled an `accepted` job and then countersigned the still-pending draft, `markCompletedByReceipt` blindly flipped the cancelled job to `completed` (the Worker's D1 CAS already guarded this — a runtime-parity bug). Now both runtimes only transition `accepted → completed`; a cancelled job stays cancelled and the receipt still finalizes (it's a valid bilateral record). **(3) `expiresAt` was stored but never consulted.** A job past its `expiresAt` is now rejected from `submitOffer` / `acceptOffer` (`JOB_EXPIRED`, §3.2) — lazy enforcement at the gates; automatic status transition to a terminal state still needs a sweeper and stays deferred (§10). New error codes `DISPUTE_ALREADY_RESOLVED`, `NOT_DISPUTED`, `NOT_DISPUTE_OPENER`, `JOB_EXPIRED`. Additive: `openedBy`/`resolvedAt`/`resolution` are absent until a dispute is opened/resolved, no existing endpoint shape changes, and the new checks only reject previously-nonsensical requests. New `client.resolveDispute()` in both SDKs. No D1 migration (the dispute object is stored inside the receipt `data` JSON blob).

**Changes from v0.13:** the same external audit flagged that INAM had no key-management story at all — an INAM ID *is* its Ed25519 key (§2), so a compromised or lost key meant an identity (and its accumulated reputation) was either permanently exposed or permanently stranded, with no protocol-level response. New **§2.2**: `POST /agents/:id/revoke` *(signed, self only)* — a one-way, self-signed tombstone. A revoked ID gets `revokedAt`/`revocationReason` on its record, is rejected from every further signed operation (`AGENT_REVOKED`, enforced at the signature-verification choke point), drops out of `GET /agents/search` (unless `?include_revoked=true`), and is flagged `revoked` in its reputation response. Finalized-receipt history is left intact — it's a record of what happened — but a consumer sees the identity is retired and stops trusting it going forward. This is the compromise-response / rotate-off tool, to be used *while the agent still controls the key*; it does **not** recover a stolen key or migrate reputation to a new key — a signed successor-chain for true rotation is explicitly deferred (§10). New Worker D1 columns `revoked_at`/`revocation_reason` (migration `migration-add-revocation.sql` — must run before deploy). Additive: `revokedAt`/`revocationReason` are absent for an active agent, and every existing endpoint's shape is unchanged.

**Changes from v0.12:** the same external audit flagged that the `linked` map (§2) presents every external-identity type identically — a flat `{ protocol: value }` — so a consumer can't tell an `a2a_endpoint` (a bare URL the agent asserted, backed only by its INAM signature) from an `agentpass_id`/`aitp_id`/`passport_id` that went through the §2.1 challenge/response. Both read as "verified identity X." The registry also didn't record *which* external key a challenge-verified link proved possession of, or *when* — so the proof couldn't be re-checked and there was nothing for a future cross-registry resolution step to anchor to. Fixed additively: the agent record gains `linkedProof`, a sibling map keyed by the same protocol names, each entry `{ method, verifiedAt, keyType?, externalPublicKey? }`. `method` is `"key_possession"` for a challenge-verified link (with the proven `keyType` + `externalPublicKey` recorded) or `"unverified_claim"` for `a2a_endpoint`. `linked` is unchanged — existing consumers keep working; a consumer that wants the assurance level reads `linkedProof`. `GET /agents/:id/protocols` now returns both. This does **not** add live cross-registry resolution (still out of scope, §10) — `key_possession` still means "proved control of this key at link time," not "this key is authoritative for the identity on the external side." It makes that limit legible in the API instead of leaving it to a doc paragraph. New D1 column `linked_proof` on the Worker (migration `migration-add-linked-proof.sql` — must run before deploy). Additive and backward compatible.

**Changes from v0.11:** the same external audit found the replay window (§7) was bounded only by the 5-minute clock-skew tolerance: the signed-request string is `METHOD\npath\ntimestamp\nsha256(body)` and does **not** cover the `Idempotency-Key`, so a captured signed request could be replayed with a *fresh* `Idempotency-Key` — the signature still verifies, and the idempotency cache (keyed on `(caller, key)`) misses, so the handler re-executes. For endpoints without their own content-address or state-machine guard (`POST /jobs` most clearly) that meant a duplicate side effect on every replay. Fixed without a wire-format change: §7 now requires a registry to bind each verified request signature to the single `Idempotency-Key` it was first seen with, for at least the clock-skew window, and reject the same signature presented with a different key as `REPLAYED_REQUEST` (409). Separately, §7's idempotency rule is tightened: a registry **MUST** cache and replay only a *terminal successful* (2xx) response — caching a transient `5xx`/`429` would pin that failure for the cache's whole TTL, so a legitimate retry with the same key could never get through; a non-2xx now leaves the key unclaimed and a retry re-executes. New error code `REPLAYED_REQUEST`. The reference implementation's in-memory caches also gained TTL eviction (they previously grew unbounded — a slow memory-exhaustion vector from unique keys). Not wire-breaking; the signing string is unchanged and existing SDKs need no update. Implemented and verified in both runtimes with new regression tests plus a live replay proof against a running server.

**Changes from v0.10:** the same external audit found `GET /agents/:id/reputation` reported `components.volumeUsd` by summing every finalized receipt's `settlement.amount` *regardless of `settlement.currency`* — a receipt settled in 1000 TRY added 1000 to a field labelled USD, right next to a 25 USDC one, producing a single meaningless cross-currency number. `settlement.amount`/`currency` (and a job's `budget`, §3.1) were also unvalidated `string` fields: `{ "amount": "banana" }` or a negative amount passed, then `Number("banana")` → `NaN` poisoned the running volume sums. Fixed without INAM taking on any FX or settlement role (that stays out of scope, §10): §5.3's `components` gains `volumeByCurrency` (a `currency → total` map, amounts bucketed by the currency they were actually denominated in, never converted or cross-summed; keys normalized to upper-case, an untagged amount bucketed as `"USD"`), and `volumeUsd` is now defined as exactly the `"USD"` bucket — no other currency, stablecoins included, folds into it. `asProvider`/`asRequester` (v0.8) get the same `volumeByCurrency` split. `settlement.amount` and `budget.amount` must now be a non-negative decimal string and `currency` a short code-shaped token (`VALIDATION_ERROR` otherwise); the reputation computation also guards a non-finite or negative amount as zero contribution, same principle as §5.2's non-finite-weight guard, since data from a non-conformant registry still flows through. Additive for any consumer reading `volumeUsd`, but its value changes for any agent with non-USD settlements (it drops to the USD-only total) — and a receipt or job carrying a malformed amount/currency that a previous version accepted is now rejected. Implemented and verified in both runtimes with new regression tests plus a live cross-language proof (Python SDK drafting USD/TRY/USDC receipts against a running Node server).

**Changes from v0.9:** §12.3 rule 4 previously required only that a `verifier` be "a registered agent" — but that's a self-service bar: any caller can `POST /agents` for free and immediately start submitting Verifications. An audit found this made "how many verifiers attested a receipt" meaningless as an independence signal — it never restricted who could verify, only that they'd taken the zero-cost step of registering, so verifier *count* carried no real assurance and §12.5's verified-vs-rejected tiebreak (v0.9) could be trivially outweighed by an adversary minting throwaway registered identities. Fixed by making verifier status an explicit grant: a new `isAuthorizedVerifier` boolean on the agent record (§2), `false` by default at registration, settable only by a single registry-configured **operator** identity via the new `POST /agents/:id/verifier-status` (§12.6) — rule 4 now checks this flag instead of mere registration, rejecting an unauthorized caller with `VERIFIER_NOT_AUTHORIZED` and rejecting a non-operator's attempt to grant/revoke status with `NOT_OPERATOR`. A registry with no operator identity configured accepts no such requests at all — the locked-down state is the default, not the permissive one. This does not, by itself, make a verifier a genuinely independent legal/organizational entity (same boundary as before, §0) — it does make verifier status something the registry operator deliberately grants rather than something anyone can self-issue, which is what "independent" was actually supposed to mean here. Breaking in a narrow sense: any receipt-verification flow relying on the old "just register" path now needs an operator grant first; wire shapes for existing endpoints are unchanged.

**Changes from v0.8:** the same external audit found the reputation boost's eligibility rule (§12.5) let a single `verified` Verification grant the boost no matter how many *different* verifiers independently `rejected` the same receipt (§12.3 only ever restricted one verifier's own consistency, never how many different verifiers may weigh in) — a real exploit for a receipt's own two parties, not a missing feature. §12.5 is tightened: the boost now requires `verified` to strictly outnumber `rejected` among all Verifications referencing the receipt, not merely "at least one verified exists." This is deliberately a narrow anti-exploit tiebreak, not the multi-verifier consensus mechanism §12.7 still defers to v0.2 (no verifier-trust weighting, no quorum) — the common single-verifier case is unaffected. Additive in effect (only removes previously-granted boosts from a specific adversarial pattern; the ordinary case is unchanged) — no wire-format or request-shape change.

**Changes from v0.7:** the same external audit (v0.6/v0.7) also pointed out that `GET /agents/:id/reputation`'s aggregate fields don't distinguish an agent's history as a receipt's provider (did the work) from its history as requester (commissioned and paid for it) — two brand-new counterparties finishing one receipt get identical-looking aggregate reputations regardless of role, since nothing in the formula is role-aware. §5.3 gains two new, purely additive response fields, `components.asProvider`/`components.asRequester` (a role-filtered breakdown using the same weighting as the aggregate, not a new scoring formula), plus prose definitions clarifying `verifiedReceipts` (means finalized, not independently verified — a real naming footgun, but not changed since it's a live, published field and renaming it would be a breaking change) and the reference formula's ~80 asymptotic ceiling without a live staking mechanism. A full role-based scoring redesign (first-class `providerScore`/`requesterScore`/`verifierScore` values) is explicitly out of scope for this version — flagged as real follow-up design work, not attempted here. Additive and backward compatible; no existing field changes meaning or shape.

**Changes from v0.6:** the same external audit that prompted v0.6 also found the reputation decay formula (§5.2) had no bounds on `result.completedAt`: a future timestamp makes `ageDays` negative, which the formula (`2^(-ageDays/halfLife)`) turns into a decay factor *greater than 1* — a receipt claiming to complete in the future would be weighted as more trustworthy than a receipt completing right now, unboundedly so the further out the claimed date. §4.3 gains a new `INVALID_TIMESTAMP` validation rule (reject a `result.completedAt` more than a small clock-skew tolerance in the future, or preceding `task.createdAt`) and §5.2's decay is now specified as clamped to `[0, 1]` regardless, so any receipt stored before this validation existed is still safe. `task.createdAt`/`result.completedAt` must also now be valid date-time strings (previously any non-empty string was accepted) — verified compatible with both this repo's TypeScript (`Date.prototype.toISOString()`, `...053Z` suffix) and Python (`datetime.isoformat()`, `...+00:00` suffix, different fractional-second precision) timestamp formats before shipping, live-proven against a local server with the Python SDK. Additive and backward compatible for any already-valid receipt; only rejects requests that were previously accepted by mistake.

**Changes from v0.5:** an external audit found §12.3's self-verification guard checked only `verifier != provider`, not `verifier != requester` — a receipt's requester (`agentA`, who already approved the work by countersigning it) could name itself as the "independent" verifier with no check at all, defeating the collusion guard just as completely as the provider self-verifying would. Fixed: §12.3 rule 3 now excludes both parties to the receipt, not just the provider. Two more checks added at the same time, closing gaps the same audit found: §12.3 now requires a verifier to be a registered agent (new `AGENT_NOT_FOUND` path for this endpoint), and a verifier may submit at most one decision per receipt (new `VERIFIER_ALREADY_DECIDED`) — previously the same verifier could submit a `verified` and, separately, a `rejected` Verification for the same receipt (different content, so §12.3 rule 7's content-hash duplicate check didn't catch it), leaving both as live, contradictory records with no way to tell which was authoritative. None of this proves a verifier is a genuinely independent legal/organizational entity distinct from the receipt's parties — that's explicitly out of scope for INAM per §0's own boundary (identity/authorization is AgentPass/AITP/Passport Alliance/DID's job, not this protocol's); what changed here is closing concrete, checkable gaps within the guarantees this spec already claimed to make. Additive and backward compatible — every existing endpoint and wire shape is unchanged, and the new checks only make previously-accepted-but-unintended requests newly rejected. Implemented and verified in both runtimes with new regression tests reproducing the audit's findings directly.

**Changes from v0.4:** adds the **Verification** resource (§12) — a single independent verifier's signed attestation that a finalized receipt's output satisfies its job's requirements, closing the "no enforcement behind `independent_validator`/`test_suite_pass`" gap called out since v0.1. Deliberately narrow: one verifier per verification, `provider != verifier` strictly enforced, only `deterministic`/`agent_attestation` methods, no new dispute mechanism (reuses the existing receipt dispute state — a disputed receipt's exclusion from reputation isn't overridden by any Verification referencing it), no verifier-side reputation yet. Additive and backward compatible — every existing endpoint and wire shape is unchanged. Implemented in all three runtimes (Node, Cloudflare Workers, both SDKs) and verified end to end, including a real cross-language proof: a receipt drafted in Python, finalized in TypeScript, then independently verified by a third TypeScript identity, correctly boosting the Python-side provider's reputation.

**Changes from v0.1 (carried forward in v0.2):** normative (MUST/SHOULD/MAY) language throughout, replacing descriptive prose where conformance actually matters; documented the rate limiting and CORS policies added during the v0.1→v0.2 hardening pass, including the `RATE_LIMITED` error code; documented the second live deployment (Cloudflare Workers) and its custom domain. No wire-format break in either bump — `receiptVersion` stays `"1.0"`.

### Keyword conventions

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): MUST/MUST NOT mark conformance requirements every registry has to meet for interoperability; SHOULD/SHOULD NOT mark strong defaults a registry can deviate from with a documented reason; MAY marks a genuine implementation choice. Where a section describes the reference implementation's specific algorithm (e.g. the exact reputation formula in §5.2) rather than a conformance requirement, that's called out explicitly — registries are free to compute reputation differently as long as the response shape (§5.3) and its auditability are honored.

## 0. Positioning

INAM is the open reputation, verification, and economic-history layer for the agent economy.

INAM is **not** an agent communication protocol. Use [MCP](https://modelcontextprotocol.io) for agent↔tool and [A2A](https://a2a-protocol.org) for agent↔agent messaging.

INAM is **not** an identity or authorization replacement. Use [AgentPass](https://github.com/clerk/agentpass), [AITP](https://www.ietf.org/archive/id/draft-song-anp-aitp-00.html), [Passport Alliance](https://www.passportalliance.org/), or W3C DID/VC for who an agent is and what it's allowed to do.

INAM is **not** an agent runtime or hosting platform. Agents run wherever they already run — OpenAI, Claude, Gemini, self-hosted, anywhere with an outbound HTTP connection.

What INAM *is*: a neutral place for two agents (running anywhere, built by anyone, under any identity standard) to (1) find each other by capability, (2) produce a cryptographically verifiable record that a piece of work actually happened, and (3) accumulate a portable, evidence-based reputation from that record — instead of a five-star rating anyone can fake.

## 1. Terminology

- **Agent** — any software entity holding an Ed25519 keypair and registered with an INAM Registry.
- **Registry** — an INAM-protocol-speaking server implementing the REST API in §6. Multiple registries may exist; this spec does not mandate a single canonical instance.
- **Requester (`agent_a`)** — the party commissioning work, referenced as the one who countersigns a receipt and typically pays. When a Job resource (§3) is used, this is the job's **poster**.
- **Worker (`agent_b`)** — the party performing the work, referenced as the one who first drafts a receipt. When a Job resource is used, this is the offering agent whose offer got **accepted**.
- **Job** — an optional, discoverable pre-work resource: a capability request a poster puts up, other agents make offers against, and the poster accepts one of (§3).
- **Execution Receipt** — the signed, content-addressed record of one completed interaction between two agents (§4).

## 2. INAM ID

An INAM ID is a [`did:key`](https://w3c-ccg.github.io/did-method-key/) built from the agent's Ed25519 public key:

```
did:key:z<base58btc(multicodec(0xed01) || raw Ed25519 public key)>
```

This is self-certifying: any verifier can validate a signature against an INAM ID without looking anything up in a registry — the public key is embedded in the identifier itself. A verifier **MUST** be able to validate a signature against an INAM ID using only the ID and RFC 8032 Ed25519 verification — it **MUST NOT** need to query a registry to do so. A registry is only needed to learn an agent's *reputation*, *capabilities*, or *linked external identities*.

An agent's registry profile also carries a `linked` map to identities issued by other systems, plus a `linkedProof` map (v0.13) recording how each link was verified:

```json
{
  "id": "did:key:z6Mk...",
  "capabilities": ["translation.tr-en"],
  "linked": {
    "agentpass_id": "ap_x91k...",
    "a2a_endpoint": "https://worker.example/a2a"
  },
  "linkedProof": {
    "agentpass_id": {
      "method": "key_possession",
      "verifiedAt": "2026-08-21T18:59:26Z",
      "keyType": "p256",
      "externalPublicKey": "A2c3..."
    },
    "a2a_endpoint": { "method": "unverified_claim", "verifiedAt": "2026-08-21T19:02:10Z" }
  },
  "stakeUsd": 0,
  "isAuthorizedVerifier": false,
  "createdAt": "2026-08-21T18:59:26Z"
}
```

`linkedProof` is keyed by the same protocol names as `linked`. Each entry's `method` is one of:

- **`key_possession`** — the link went through §2.1's challenge/response; the caller proved control of `externalPublicKey` (recorded, along with `keyType`) at `verifiedAt`. This is **not** a claim that the key is the one the external system currently recognizes as authoritative for `value` — that live cross-registry resolution is out of scope (§10). A consumer **SHOULD** read it as "proved control of this key at link time" and **MAY** re-check the key against the external system itself.
- **`unverified_claim`** — the link is an INAM-signed assertion only, with no external proof. This is `a2a_endpoint` (a service URL, not a key-derived identity).

A registry **MUST** populate `linkedProof` for every entry in `linked`. A consumer **SHOULD NOT** treat an `unverified_claim` link, or the *identity string* of a `key_possession` link, as a proven identity binding.

`isAuthorizedVerifier` (v0.10) is `false` for every agent at registration and stays `false` until the registry's configured **operator** identity explicitly grants it via `POST /agents/:id/verifier-status` (§12.3, §12.6) — there is no self-service path to becoming eligible to submit a Verification (§12). This is deliberate: independence as an assurance signal only means something if verifier status isn't something any freshly-registered identity can claim for itself.

A registry **MUST** verify that a `POST /agents/:id/link` request is signed by the same INAM ID it targets (§7) before storing a `linked` entry — this proves control of the *INAM* ID, not, by itself, control of the external identity being claimed. `a2a_endpoint` is a plain service URL rather than a key-derived identity, so INAM signature control is the only proof that applies to it. For `agentpass_id` / `aitp_id` / `passport_id`, §2.1 below adds cryptographic proof of control of the external key.

### 2.1 External identity linking (challenge-response)

Before a registry stores an `agentpass_id` / `aitp_id` / `passport_id` claim, the caller **MUST** prove control of the external public key via a single-use signed challenge — a two-step exchange:

**Step 1 — `POST /agents/:id/link/challenge`** *(signed by the INAM ID, self only)*: request body `{ protocol, externalPublicKey, keyType }`, where `externalPublicKey` is the claimed external key, base64-encoded, and `keyType` is `"ed25519"` or `"p256"`. The registry generates and stores a single-use challenge and responds `201` with:

```json
{ "challengeId": "...", "challenge": "<64 hex chars>", "expiresAt": "2026-08-22T13:41:34Z" }
```

`challenge` **MUST** be 32 cryptographically random bytes, hex-encoded. A registry **MUST** reject completing a challenge after its `expiresAt` (**SHOULD** be ≤60 seconds from issuance) and **MUST** reject reusing an already-consumed `challengeId` — both **MUST** be enforced as an atomic compare-and-swap on first use, not a read-then-write (see `worker/src/db.ts`'s `consumeLinkChallengeIfUnused` for the reference CAS pattern; a naive check-then-mark-used has the same race class this codebase has already fixed twice for receipts and jobs).

**Step 2 — `POST /agents/:id/link`** *(signed by the INAM ID, self only)*: for `agentpass_id`/`aitp_id`/`passport_id`, the request body **MUST** include `challengeId` and `proofSignature` alongside `protocol`/`value`. `proofSignature` is a signature over the raw bytes of the hex-decoded `challenge` (not the hex string), produced by the *external* private key — base64-encoded. The registry verifies `proofSignature` against the `externalPublicKey` submitted in step 1 using the matching scheme, and only writes `linked[protocol] = value` if it verifies. `a2a_endpoint` skips this whole exchange — it's linked directly with just `{ protocol, value }`, as before.

**Wire format.** For `keyType: "p256"`: ECDSA over the P-256 curve, standard SHA-256 digest (i.e. plain `ECDSA-Sign(SHA-256(challenge), key)`, not a pre-hashed digest signed raw), signature as 64-byte compact `r‖s` (32-byte big-endian `r` followed by 32-byte big-endian `s`) — **not** DER. A registry **MUST** reject a non-canonical ("high-S") signature, i.e. **MUST** require `s ≤ n/2` where `n` is the P-256 group order; a signer **MUST** produce the low-S representative (this codebase's reference Python signer initially didn't, and produced a signature the reference TypeScript verifier rejected about half the time — see `sdk-python/inamprotocol/p256.py`'s doc comment). For `keyType: "ed25519"`: standard RFC 8032 Ed25519 over the raw challenge bytes, verified against the raw external public key directly (**not** wrapped in a `did:key`) — an externally-issued key doesn't need to be INAM-encoded to be linked.

This wire format is chosen to align with [ATTP](https://datatracker.ietf.org/doc/draft-sharif-attp/) (`draft-sharif-attp-00`, the trust-transport protocol AgentPass is built on), which mandates P-256 as its primary curve and specifies this exact challenge/signature shape. That alignment is **best-effort, not a conformance claim** — this reference implementation has not been certified against a live ATTP verifier, and other protocols (AITP, Passport Alliance) may use different signature conventions for their own native verification paths.

**What this does and does not prove.** A successful challenge response proves the caller currently holds the private key for the `externalPublicKey` they submitted. It does **not** call out to AgentPass/AITP/Passport Alliance's own registry to confirm that key is the one each system currently recognizes as authoritative for the claimed identity (e.g. it doesn't catch a key that was valid but has since been rotated or revoked on the external side), nor does it establish any binding between that key and the `value` string being linked — that live cross-registry resolution is explicitly **out of scope** for this reference implementation (§10) and is the next real increment beyond proof-of-possession. This limit is now explicit in the API: the link is recorded as `linkedProof[protocol] = { method: "key_possession", verifiedAt, keyType, externalPublicKey }` (§2), so a consuming client can see it is "proven control of this key at link time" — not an ongoing guarantee that the external registry still agrees, and not a proven binding of the key to the identity string.

New error codes: `UNSUPPORTED_KEY_TYPE`, `CHALLENGE_NOT_FOUND`, `CHALLENGE_EXPIRED`, `CHALLENGE_ALREADY_USED`, `CHALLENGE_MISMATCH` (challenge was issued for a different agent/protocol pair), `CHALLENGE_REQUIRED` (a key-derived protocol was submitted to `POST /agents/:id/link` without a prior challenge), `PROOF_INVALID`.

### 2.2 Identity revocation (v0.14)

An INAM ID *is* its Ed25519 public key (§2), so there is no key rotation: a key that leaks can't be re-pointed at a new keypair while keeping the same ID. What an agent **can** do is retire the ID.

**`POST /agents/:id/revoke`** *(signed by the INAM ID, self only)*: request body `{ reason }` (a non-empty string, ≤500 chars). The registry sets `revokedAt` (server-assigned ISO timestamp) and `revocationReason` on the agent record and returns `200` with the full updated record. Revocation is **one-way** — a registry **MUST** reject a second `revoke` on an already-revoked ID (it will already be rejected by the rule below, as `AGENT_REVOKED`), and **MUST NOT** offer an un-revoke.

Once `revokedAt` is set, a registry **MUST**:

- **Reject every signed request** from that ID with `AGENT_REVOKED` (403). The reference implementations enforce this at the one point every signed route already passes through (`requireSignedRequest`), so it covers jobs, offers, receipts, countersigns, disputes, verifications, links, and a repeat revoke uniformly. Registering a *new*, different ID is unaffected.
- **Exclude it from `GET /agents/search`** by default. `?include_revoked=true` opts back in (for a caller auditing history).
- **Flag it** `revoked` in the `GET /agents/:id/reputation` `flags` array.

A registry **MUST NOT** delete the record or alter the agent's existing finalized/disputed receipts — revocation is a forward-looking tombstone, not a history rewrite. A receipt already finalized before revocation stays valid and still contributes to *counterparties'* reputation (they didn't do anything wrong); the revoked agent's own reputation simply carries the `revoked` flag so a consumer knows not to transact with it now.

**Deliberately not in this version:** a signed successor-chain (`revoke` naming a new INAM ID, with a signature from the old key over the new ID, letting reputation migrate). That's real design work — how much reputation carries, how a consumer verifies the chain, what stops a compromised key from naming an attacker's ID as successor — and is deferred (§10). v0.14's revoke is the minimal, safe primitive: burn the ID, don't pretend to move it.

New error code: `AGENT_REVOKED`.

## 3. Job

A Job is how two agents find each other and agree to work together *before* any Execution Receipt exists. It is **optional** — nothing in §4 requires a Job to back a receipt's `jobId`; two parties who already know each other (found each other via A2A discovery, an out-of-band marketplace, direct integration) can skip straight to a receipt with an arbitrary `jobId` string, exactly as in v0.1/v0.2. A Job exists purely to make capability discovery and offer/accept itself part of the protocol, for the common case where the parties don't already know each other.

### 3.1 Shape

```json
{
  "jobId": "job_1a2b3c4d",
  "postedBy": "did:key:z...",
  "capability": "translation.tr-en",
  "specHash": "sha256:...",
  "budget": { "amount": "12.50", "currency": "USDC" },
  "status": "open",
  "offers": [
    { "agentId": "did:key:z...", "message": "I can do this", "createdAt": "2026-08-22T10:00:00Z" }
  ],
  "acceptedAgentId": null,
  "receiptId": null,
  "createdAt": "2026-08-22T09:58:00Z",
  "expiresAt": null
}
```

`specHash` follows the same principle as a receipt's `task.specHash` (§4.1): a hash of the job description, not the description itself — a registry is a discovery index, not a document store. `budget` is informational only; a registry **MUST NOT** treat it as a payment commitment (§10 — payment enforcement is out of scope).

### 3.2 Lifecycle

```
open ──(poster accepts one offer)──▶ accepted ──(a matching receipt finalizes)──▶ completed
  └──(poster cancels)──▶ cancelled
```

1. **Open.** Any registered agent other than the poster **MAY** submit an offer while a job is `open`. A registry **MUST** reject an offer from the job's own poster (`SELF_DEALING`) and **MUST** reject a second offer from an agent that already has one on the same job (`OFFER_ALREADY_SUBMITTED`). If `expiresAt` is set and has passed, a registry **MUST** reject a new offer or an acceptance with `JOB_EXPIRED` — the job's `status` field is *not* required to auto-transition (that needs a background sweeper, deferred — §10), but an expired job **MUST NOT** accept new work at the gates.
2. **Accepted.** Only the poster **MAY** accept an offer, and only while the job is still `open`; accepting **MUST** set `acceptedAgentId` and move `status` to `accepted`. A registry **MUST** reject an offer attempt against a non-`open` job (`JOB_NOT_OPEN`).
3. **Completed.** Once an Execution Receipt referencing this `jobId` is **finalized** (§4.3), a registry **MUST** transition the job to `completed` *if it is still `accepted`* and set `receiptId` to that receipt's id — this transition **MUST** be `accepted → completed` only, never from `cancelled` (if the poster cancelled the job between the draft and its finalization, the job stays `cancelled`; the receipt still finalizes as a valid bilateral record, the job resource just doesn't claim it). A registry **MUST** reject a receipt draft whose `jobId` references a job that is not yet `accepted`, or whose `agentA`/`agentB` don't match the job's `postedBy`/`acceptedAgentId` exactly (`JOB_NOT_ACCEPTED` / `JOB_PARTY_MISMATCH`) — otherwise an unrelated pair of agents could complete someone else's job by coincidentally reusing its id.
4. **Cancelled.** Only the poster **MAY** cancel, and only before completion; a registry **MUST** reject cancelling an already-`completed`/`cancelled` job (`JOB_NOT_CANCELLABLE`).

`worker/src/db.ts`-equivalent atomicity requirements from §4.3 apply here too in spirit — a conforming registry **MUST NOT** allow two concurrent accepts (or an accept racing a cancel) to both succeed.

## 4. Execution Receipt

The core primitive. Not written to any blockchain — a receipt is a plain signed JSON document, cheap to produce, and portable outside any single registry.

### 4.1 Shape

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

`settlement` is optional and, when present, a pointer to money that moved on some other rail — INAM does not move, hold, or verify it (§10). `settlement.amount` (and a job's `budget.amount`, §3.1) **MUST** be a non-negative decimal string; `settlement.currency`/`budget.currency` **MUST** be a short currency-code token (`^[A-Za-z0-9]{1,16}$` — an ISO-4217 code like `USD` or a stablecoin ticker like `USDC`), not free-form text. A registry **MUST** reject a violation with `VALIDATION_ERROR`. INAM defines no exchange rate between currencies and **MUST NOT** sum amounts across them (§5.3).

`verification.method` is one of `payer_confirmation`, `independent_validator`, `test_suite_pass`. **Not yet enforced:** only `payer_confirmation` has any real weight today — the other two are accepted values with no enforcement mechanism behind them (no validator selection, no test harness). Treat them as reserved, not implemented.

### 4.2 Receipt ID (content addressing)

```
receiptId = "sha256:" + hex(sha256(canonical({
  jobId, agentA, agentB, task, result, settlement, verification
})))
```

`canonical()` is the recursive key-sorted, whitespace-free JSON serializer defined in `sdk-js/src/crypto/canonical.ts` — a practical subset of RFC 8785 (JCS), not full JCS. A registry **MUST NOT** assign its own random receipt ID — `receiptId` **MUST** be computed exactly as above, and every conforming SDK **MUST** implement byte-identical `canonical()` output (see §8) so two independent parties always derive the same ID from the same content. A registry **MUST** treat a resubmission of byte-identical content as `DUPLICATE_RECEIPT`, not a new record — this follows automatically from using `receiptId` as the primary key rather than an accident of the reference implementation.

### 4.3 Lifecycle

```
draft ──(agent_a countersigns)──▶ finalized ──(either party, within window)──▶ disputed
                                       ▲                                            │
                                       └────(the dispute's opener withdraws it)─────┘
```

1. **Draft.** The worker (`agent_b`) signs the canonical content (everything above except `signatures`, `status`, `dispute`) with its own key and submits it. If `jobId` references an existing Job resource (§3), a registry **MUST** validate it per §3.2 before accepting the draft. A registry **MUST NOT** count a `draft` receipt toward reputation — a unilateral submission from either side is never sufficient on its own. `task.createdAt` and `result.completedAt` **MUST** be valid date-time strings, and a registry **MUST** reject the draft with `INVALID_TIMESTAMP` if `result.completedAt` is more than a small clock-skew tolerance (reference implementation: 5 minutes, matching §7's request-signature tolerance) ahead of the registry's own current time, or if it precedes `task.createdAt` — added in v0.7 after an audit found the reference implementation's reputation decay (§5.2) treated an unvalidated future `completedAt` as *younger than brand new*, inflating that receipt's weight without bound rather than rejecting a nonsensical claim.
2. **Finalized.** The requester (`agent_a`) reviews and countersigns the *same* canonical content. A registry **MUST** verify both signatures against the identical canonical content before setting `status: "finalized"` — it **MUST NOT** finalize on a single valid signature. Only once both verify does a `dispute.windowClosesAt` (default 72h) get set, and (if `jobId` references a Job) that job transition to `completed`. This is the point a receipt becomes reputation-eligible.
3. **Disputed.** Either party **MAY** open a dispute before the window closes; a registry **MUST** record `dispute.openedBy` and **MUST** exclude a disputed receipt from the positive side of the reputation calculation and flag the agent's reputation response `in_dispute`.
4. **Resolved (v0.15).** The party that opened the dispute — and only that party — **MAY** withdraw it via `POST /receipts/:id/dispute/resolve`, moving the receipt back to `finalized` and `dispute.status` to `"resolved"` (with `resolvedAt` and an optional `resolution` note). The receipt is reputation-eligible again and the `in_dispute` flag clears. This is **one-way**: a resolved receipt **MUST NOT** be disputable again (`DISPUTE_ALREADY_RESOLVED`), so a party can't toggle a receipt's reputation contribution on and off. INAM defines no arbitration — a resolved dispute means "the opener no longer contests it," not "a third party ruled." Binding third-party dispute resolution stays out of scope (§10).

A registry **MUST** treat the `draft`→`finalized`, `finalized`→`disputed`, and `disputed`→`finalized` (resolve) transitions as atomic compare-and-swap operations (transition only if the receipt is still in the expected prior state at write time), not read-then-write — concurrent requests targeting the same receipt are expected, and a race that lets two conflicting writes both succeed is a conformance bug, not an edge case to shrug off. `worker/src/db.ts`'s `finalizeReceiptIfDraft`/`disputeReceiptIfFinalized` are the reference implementation of this requirement.

Both signatures are independently verifiable by anyone holding the JSON — a receipt does not need the issuing registry to be trusted or even online to be checked.

## 5. Reputation Model

### 5.1 Event model

There is no separate "reputation event" ledger distinct from receipts. A finalized or disputed Execution Receipt *is* the event. This is a deliberate simplification, not an oversight: introducing a second, parallel event log would create two sources of truth that can drift. If a future need arises for reputation-affecting events with no underlying receipt (e.g. a governance-imposed penalty), it should be modeled as its own explicitly-typed event stream rather than force-fit into the receipt schema — out of scope for now.

### 5.2 Scoring

This section describes the reference implementation's algorithm, not a conformance requirement — a registry **MAY** compute `trustScore` differently as long as §5.3's response shape and the auditability principle below are honored: a registry **MUST NOT** report `trustScore` without also reporting the `components` that justify it, so a low-confidence score for a sparse-history agent is distinguishable from a bad one, not just an opaque number to trust blindly.

For an agent, the reference implementation computes reputation on demand (not cached/stored) from every `finalized`/`disputed` receipt it is party to:

- **Counterparty-trust weighting.** Each receipt's contribution is weighted by the counterparty's own independently-computed base trust (stake + volume + success ratio) — a one-step relaxation of a full EigenTrust fixed-point solve. **Not yet enforced at full strength:** this is single-pass, not an iterative solve over the whole interaction graph; that upgrade is deferred until there's enough transaction volume for it to matter.
- **Sub-linear pair weighting.** Total weight contributed by one counterparty grows with `log(pairCount)`, not linearly — repeated receipts between the same two agents (wash-trading pattern) saturate instead of compounding.
- **Time decay.** Each receipt's weight decays with a configurable half-life (default 90 days) from `result.completedAt`, clamped to `[0, 1]` — a registry **MUST NOT** let a receipt's decay factor exceed 1 (which an unvalidated future `completedAt` would otherwise produce, since the formula's `ageDays` goes negative) or fall below 0. §4.3's `INVALID_TIMESTAMP` check prevents a future `completedAt` from being accepted in the first place; this clamp is the defense for any receipt stored before that check existed, or any other source of a non-finite/out-of-range value — a registry **MUST** also treat a non-finite computed weight as zero contribution rather than letting it propagate into the running sums (`NaN` addition would otherwise poison every other receipt's contribution to the same computation, not just the one with the bad value).
- **Stake component.** A `sqrt(stakeUsd)` term contributes to trust independent of transaction history, so a new but bonded agent isn't scored purely on zero history. **Not yet enforced:** there is no endpoint yet to actually post stake; `stakeUsd` exists in the data model and formula but defaults to 0 for every agent until the payments phase ships.
- **Concentrated-counterparty flag.** If one counterparty accounts for more than 60% of an agent's finalized receipts (once there are ≥3), the response is flagged — a threshold heuristic, not real graph clustering (Leiden/Louvain), which is the documented next step.

### 5.3 Response shape

```json
{
  "trustScore": 8.7,
  "components": {
    "eigenWeight": 0.109,
    "verifiedReceipts": 2,
    "rawReceipts": 2,
    "successRate": 1.0,
    "volumeUsd": 0,
    "volumeByCurrency": { "USDC": 25 },
    "stakeUsd": 0,
    "decayHalfLifeDays": 90,
    "attestedReceipts": 0,
    "asProvider": { "receipts": 2, "successRate": 1.0, "volumeUsd": 0, "volumeByCurrency": { "USDC": 25 } },
    "asRequester": { "receipts": 0, "successRate": 0, "volumeUsd": 0, "volumeByCurrency": {} }
  },
  "flags": []
}
```

`components` is returned in full, not collapsed into `trustScore` alone — the scoring is meant to be auditable, not a black box. A low score for a brand-new, unstaked agent with only one or two transactions is correct behavior, not a bug: `eigenWeight` (confidence) is deliberately slow to rise.

Field definitions worth stating explicitly, since an audit found several were easy to misread from name alone:

- **`verifiedReceipts`** means *finalized* — a receipt both parties signed — not independently verified. A `verified` Verification (§12) is a separate, stronger claim; `attestedReceipts` (below) counts those specifically. This naming is unfortunate in hindsight but not changed in this version — `verifiedReceipts` already ships in a live, published response shape, and renaming a field a consumer might already be parsing is a real breaking change, not a documentation fix. New registries **SHOULD** consider a less ambiguous name if starting from scratch.
- **`eigenWeight`** is the reference implementation's confidence term (§5.2's one-step relaxation of a full EigenTrust fixed-point solve), not an actual EigenTrust output — same "not yet enforced at full strength" caveat as §5.2 already states.
- **`volumeUsd` / `volumeByCurrency`** (`volumeByCurrency` added in v0.11): total settlement `amount` across an agent's finalized receipts, from self-reported receipt data — *not* settlement-confirmed (INAM verifies no payment, §10). `volumeByCurrency` buckets that total by each receipt's `settlement.currency` (normalized to upper-case; an untagged amount → `"USD"`), and a registry **MUST NOT** convert between or sum across currencies — INAM defines no exchange rate. `volumeUsd` is exactly the `"USD"` bucket (`volumeByCurrency["USD"]`, or `0`); an audit found it previously added every currency's raw `amount` together as though they were all dollars. A stablecoin such as `USDC` is its own bucket, not USD — the registry takes no position on any peg. A non-finite or negative `amount` contributes `0`.
- **`asProvider`/`asRequester`** (added in v0.8): the same weighted receipt count / success rate / volume as the aggregate above, split by which role this agent held on each finalized receipt (`agentB`/provider did the work; `agentA`/requester requested and countersigned it). Added because the aggregate fields above are role-blind by construction — two brand-new counterparties finishing one receipt produce identical-looking aggregate reputations for both of them regardless of which side each was on, which is misleading for a use case like "find an agent good at doing X work" (a provider-side question) versus "find an agent that reliably commissions and pays for work" (a requester-side question). This is *not* a separate 0-100 score per role — assigning real weights to a `providerScore`/`requesterScore` pair (and a similar `verifierScore`, already-deferred verifier-side reputation per §12.7) is real scoring-model design work, not done here; a registry **MAY** compute such scores on top of this breakdown but this spec does not define one yet.
- A registry **MAY** use a different formula for `trustScore` (§5.2), but without a staking mechanism live (`stakeUsd` stays 0 for every agent until Phase 6/payments ships — see README's "Deliberate simplifications"), the reference implementation's specific formula (`20·stakeComponent + 70·successRate·confidence + 10·confidence`) has a mathematical ceiling around 80, not 100, no matter how much successful history an agent accumulates — worth knowing before treating the `/100` scale as implying 100 is reachable through work history alone.

## 6. REST API

Base path `/v1`. A `(signed)` endpoint **MUST** reject a request missing a valid signature (§7) or `Idempotency-Key` header — these are conformance requirements, not defaults a registry can silently relax. A registry **MUST** implement every endpoint below with the request/response shapes given; it **MAY** add endpoints beyond this list (e.g. its own admin/billing routes) but **MUST NOT** repurpose these paths for something incompatible with this spec.

| Method & path | Description |
|---|---|
| `POST /agents` *(signed)* | Register the calling INAM ID with a capability list and free-form metadata. |
| `GET /agents/:id` | Fetch an agent's public profile. |
| `GET /agents/:id/protocols` | Fetch an agent's linked external identities (`linked`) and their per-link assurance metadata (`linkedProof`, §2). |
| `GET /agents/:id/reputation` | Compute and return the reputation result (§5.3). No auth required — reputation is public by design. |
| `GET /agents/:id/receipts` | List an agent's receipts (draft, finalized, and disputed). |
| `POST /agents/:id/revoke` *(signed, self only)* | One-way retire this INAM ID (§2.2). Body `{ "reason": "..." }`. Response `200` with the updated record. |
| `GET /agents/search?capability=&min_reputation=&supports=` | Discover agents by capability, minimum trust score, and/or which external protocol they support. |
| `POST /agents/:id/link/challenge` *(signed, self only)* | Request a single-use proof-of-control challenge before linking a key-derived external identity (§2.1). |
| `POST /agents/:id/link` *(signed, self only)* | Claim an external identity (§2); `agentpass_id`/`aitp_id`/`passport_id` require a completed challenge (§2.1), `a2a_endpoint` does not. |
| `POST /jobs` *(signed)* | Post an open job (§3). |
| `GET /jobs/:id` | Fetch a single job. |
| `GET /jobs/search?capability=&status=` | Discover jobs, typically filtered to `status=open`. |
| `POST /jobs/:id/offers` *(signed)* | Submit an offer on an open job. |
| `GET /jobs/:id/offers` | List a job's offers. |
| `POST /jobs/:id/accept` *(signed, poster only)* | Accept one offer, moving the job to `accepted`. |
| `POST /jobs/:id/cancel` *(signed, poster only)* | Cancel a not-yet-completed job. |
| `POST /receipts` *(signed)* | Submit a draft receipt, signed by `agent_b`. |
| `GET /receipts/:id` | Fetch a single receipt. |
| `POST /receipts/:id/countersign` *(signed, agent_a only)* | Countersign a draft receipt, finalizing it. |
| `POST /receipts/:id/dispute` *(signed, participant only)* | Open a dispute within the window (§4.3). |
| `POST /receipts/:id/dispute/resolve` *(signed, dispute opener only)* | Withdraw an open dispute, `disputed → finalized` (§4.3). Body `{ "note"?: "..." }`. One-way. |
| `POST /verifications` *(signed, caller = verifier)* | Submit a signed independent verification of a finalized receipt (§12). |
| `GET /verifications/:id` | Fetch a single verification. |
| `GET /receipts/:id/verifications` | List verifications referencing a receipt. |
| `POST /agents/:id/verifier-status` *(signed, caller = operator only)* | Grant or revoke `:id`'s verifier authorization (§12.3, §12.6). |

### Error shape

```json
{ "error": { "code": "AGENT_NOT_FOUND", "message": "..." } }
```

Codes in the current implementation: `MISSING_SIGNATURE`, `STALE_SIGNATURE`, `INVALID_SIGNATURE`, `MISSING_IDEMPOTENCY_KEY`, `VALIDATION_ERROR`, `INVALID_JSON`, `AGENT_NOT_FOUND`, `AGENT_ALREADY_REGISTERED`, `NOT_SUBJECT_AGENT`, `UNSUPPORTED_PROTOCOL`, `RECEIPT_NOT_FOUND`, `SELF_DEALING`, `DUPLICATE_RECEIPT`, `INVALID_RECEIPT_SIGNATURE`, `NOT_DRAFT`, `NOT_REQUESTER`, `NOT_FINALIZED`, `DISPUTE_WINDOW_CLOSED`, `NOT_PARTICIPANT`, `ROUTE_NOT_FOUND`, `RATE_LIMITED`, `JOB_NOT_FOUND`, `JOB_NOT_OPEN`, `JOB_NOT_ACCEPTED`, `JOB_NOT_CANCELLABLE`, `JOB_PARTY_MISMATCH`, `NOT_POSTER`, `OFFER_NOT_FOUND`, `OFFER_ALREADY_SUBMITTED`, `RECEIPT_NOT_FINALIZED`, `NOT_VERIFIER`, `SELF_VERIFICATION`, `VERIFICATION_TARGET_MISMATCH`, `UNSUPPORTED_VERIFICATION_METHOD`, `INVALID_VERIFICATION_SIGNATURE`, `DUPLICATE_VERIFICATION`, `VERIFICATION_NOT_FOUND`, `VERIFIER_ALREADY_DECIDED`, `INVALID_TIMESTAMP` (v0.7, §4.3), `VERIFIER_NOT_AUTHORIZED`, `NOT_OPERATOR` (v0.10, §12.6), `REPLAYED_REQUEST` (v0.12, §7), `AGENT_REVOKED` (v0.14, §2.2), `DISPUTE_ALREADY_RESOLVED` / `NOT_DISPUTED` / `NOT_DISPUTE_OPENER` / `JOB_EXPIRED` (v0.15, §3.2/§4.3) (this list previously omitted the §12 Verification codes and the §7-adjacent `INVALID_JSON`, an existing documentation gap fixed alongside the v0.6 changes above, not new behavior).

### Rate limiting

`POST /agents` is limited per source IP (a DID costs nothing to mint, so limiting by identity would do nothing against a spammer generating fresh keypairs). Every other `(signed)` write — including all Job endpoints — is limited per calling INAM ID. `GET /agents/search` and `GET /agents/:id/reputation` — the two reads expensive enough to walk an agent's full receipt history — are limited per source IP even though they require no signature, since they're otherwise a free way to trigger repeated O(receipts) backend reads. A `429` with code `RATE_LIMITED` means back off and retry later; specific limits are a deployment policy, not a protocol guarantee, and may differ between registries.

### CORS

Public GET reads respond with `Access-Control-Allow-Origin: *` — they're meant to be queryable from a browser with no account, matching §6's "reputation is public" design. Signed mutating routes send no CORS headers at all: they're server-to-server/agent-to-agent by design, and since auth is a per-request Ed25519 signature rather than an ambient browser credential (a cookie, say), CORS restriction there is a scope-narrowing choice, not a security boundary — a malicious web page still can't forge a signature it doesn't hold the private key for.

## 7. Request signing

Every mutating call is signed by the caller's own INAM ID — there is no separate API-key concept. This is a simplified, RFC 9421 (HTTP Message Signatures)-inspired scheme, not full structured-field compliance:

```
inam-agent:      did:key:z...
inam-timestamp:  <unix ms>
inam-signature:  base64(Ed25519(
                    `${METHOD}\n${fullPath}\n${timestamp}\n${sha256hex(rawBody)}`
                  ))
```

`fullPath` **MUST** be the complete request path including any mount prefix (e.g. `/v1/agents/:id/link`), not a router-relative path — implementers behind a sub-router **MUST** sign/verify against the full original URL, or every signature on a sub-routed endpoint fails to verify (this broke the reference implementation once; see `worker/src/signedRequest.ts`'s doc comment). A registry **MUST** reject a request whose timestamp is outside its configured clock-skew window (5 minutes in the reference implementation) to bound replay; it **SHOULD** use a window in that range — wide enough to tolerate real clock drift, narrow enough that a captured request/signature can't be replayed indefinitely.

Idempotency: a mutating endpoint **MUST** require an `Idempotency-Key` header. A registry **MUST** cache the response of a terminal *successful* (2xx) operation and replay it for a repeated `(caller, key)` pair instead of re-executing; it **MUST NOT** cache a non-2xx response (a transient `5xx`/`429` would otherwise pin that failure for the cache TTL and make a legitimate retry impossible) — a non-2xx leaves the key unclaimed and a retry re-executes.

Replay: the signing string above does not cover the `Idempotency-Key`, so a captured signed request replayed with a *fresh* key would re-verify and miss the idempotency cache. To close this, a registry **MUST** bind each verified request signature to the single `Idempotency-Key` it was first presented with, for at least the clock-skew window, and **MUST** reject the same signature presented with a *different* key as `REPLAYED_REQUEST` (409). The same signature with the *same* key is a normal retry (served from the idempotency cache if a success was recorded, otherwise re-executed). The reference implementation keeps this binding in the same store as the idempotency cache — in-memory for `/src` (lost on restart; a real multi-instance deployment needs a shared TTL store), KV for `/worker` (its cross-edge eventual consistency leaves a ~60s cross-location race, with each operation's own content-address / state-machine guards as the backstop; a hard guarantee needs a Durable Object or D1).

## 8. SDK architecture

An INAM SDK, in any language, **MUST** provide:

1. **Keypair generation and INAM ID encoding** (§2) — `did:key` from an Ed25519 public key.
2. **Canonical JSON serialization** (§4.2) matching `sdk-js/src/crypto/canonical.ts` **byte-for-byte** — this is the one piece of logic that **MUST** be identical across every language implementation; two SDKs disagreeing here sign/verify different bytes for what looks like the same receipt, and neither will notice until a cross-SDK countersign fails.
3. **Request signing** per §7.
4. **Receipt content + ID construction** per §4.2 (see `sdk-js/src/core/receiptContent.ts` for the reference logic).
5. A thin client wrapping the REST calls in §6: `registerAgent`, `getAgent`, `linkIdentity`, `requestLinkChallenge`, `completeLink`, `searchAgents`, `getReputation`, `listReceipts`, `submitWork` (draft), `acceptWork` (countersign), `disputeReceipt`.
6. **P-256 sign/verify** (§2.1) alongside Ed25519, for external-identity challenge proofs — the low-S canonicalization requirement in §2.1 applies to the SDK's signer, not just the registry's verifier.

An SDK **SHOULD** ship a fixed-vector interop test — sign/canonicalize a known payload with a known test key and compare byte-for-byte against a value generated by another language's SDK — rather than relying on end-to-end demos alone to catch a canonicalization drift. `sdk-python/tests/test_interop.py` and `scripts/interop-vectors.ts` are the reference pattern.

Reference implementations: `inamprotocol` on npm (TypeScript, `InamClient`; source `sdk-js/src/client.ts`) and `inamprotocol` on PyPI (Python, `InamClient`; source `sdk-python/inamprotocol/client.py`). Cross-language interop is a first-class correctness requirement — a receipt drafted by the Python SDK must countersign correctly against a TypeScript client and vice versa, because both compute the identical canonical bytes. Both SDKs also provide Job methods (`postJob`/`post_job`, `searchJobs`/`search_jobs`, `submitOffer`/`submit_offer`, `acceptOffer`/`accept_offer`, `cancelJob`/`cancel_job`) — see `sdk-python/examples/job_demo.py` for the full flow — and external-identity link-challenge methods (`requestLinkChallenge`/`request_link_challenge`, `completeLink`/`complete_link`) — see `sdk-python/examples/link_challenge_demo.py`. The P-256 canonicalization requirement in §2.1 is a real cross-language interop hazard, not a hypothetical one: this reference implementation's own Python signer initially produced non-canonical signatures the TypeScript verifier rejected about half the time, caught by running the demo repeatedly rather than by a single passing run.

## 9. Versioning

`receiptVersion` and the `/v1` API path version independently. A breaking change to the receipt schema increments `receiptVersion`; a breaking change to the API surface ships as `/v2`, with `/v1` kept live for at least 18 months (target — not yet tested in practice, no protocol version has shipped a breaking change yet).

## 10. Explicitly out of scope

Not deferred by accident — deferred because building them before the primitives above are solid would be premature:

- Automatic job **status transition** on expiry. As of v0.15 an expired job is rejected from `submitOffer`/`acceptOffer` at the gates (`JOB_EXPIRED`, §3.2), but its stored `status` still reads `open` — flipping it to a terminal `expired`/`cancelled` state on its own needs a background sweeper, which stays deferred.
- Payments/settlement enforcement (`settlement` and a job's `budget` are recorded, and their `amount`/`currency` are shape-validated (§4.1), but never verified against x402/AP2/on-chain state, and no exchange rate between currencies is defined — `components.volumeByCurrency` (§5.3) reports self-reported volume bucketed by currency, unconverted).
- Stake posting/slashing endpoints.
- **Key rotation / signed successor-chain.** §2.2's `revoke` is one-way — burn the ID. It does not let an agent name a new INAM ID as successor and carry reputation across (with a signature from the old key proving the link). Doing that safely — how much reputation carries, how a consumer verifies the chain, what stops a compromised key from naming an attacker's ID as successor — is real design work, deferred until there's demand for it.
- TEE remote attestation for `verification.method: independent_validator`.
- Live cross-registry resolution for linked external identities: §2.1's challenge proves the caller holds the claimed external key *today*, but a registry does not call out to AgentPass/AITP/Passport Alliance's own APIs to confirm that key is still the one each system currently recognizes as authoritative (e.g. it wouldn't catch a rotated or revoked external key), nor that the key belongs to the `value` string being linked. `linkedProof` (§2) makes this assurance level explicit per link (`key_possession` vs `unverified_claim`) rather than closing the gap.
- ATTP conformance certification — §2.1's wire format aligns with `draft-sharif-attp-00` by design, but this has not been tested against a live ATTP verifier.
- Trust-score penalties for repeated failed challenge attempts (ATTP §4 recommends this; this reference implementation just lets the challenge expire normally after a failed attempt).
- Full iterative EigenTrust solve and real graph-clustering-based collusion detection.
- Ranking/matching logic for job offers beyond a flat list (e.g. sorting offers by the offering agent's reputation) — a registry **MAY** add this as a read-side convenience without a spec change, since it doesn't affect wire format or conformance.
- Any UI, marketplace, or payment product surface.

## 11. Relationship to other protocols

| Protocol | Layer | INAM's relationship |
|---|---|---|
| MCP | Agent ↔ Tool | Complementary — an INAM SDK can be exposed as an MCP server's tools. |
| A2A | Agent ↔ Agent transport | Complementary — INAM doesn't replace how agents talk, only how their completed work is verified and scored afterward. |
| AgentPass, AITP, Passport Alliance, W3C DID/VC | Identity & delegation | Complementary — `linked` (§2) references these; INAM does not mint or arbitrate authorization. §2.1's link-challenge wire format follows ATTP (the trust-transport protocol AgentPass is built on) so proof-of-control interops with that ecosystem's own key material, but INAM still doesn't call out to their registries as the authority on delegation/mandate scope — that stays theirs. |
| x402, AP2, ACP | Payment | Complementary — `settlement.paymentRef` (§4.1) and a job's `budget` (§3.1) are designed to hold a reference into one of these; INAM does not move money itself. |
| OpenWork.network | Agent marketplace / economic-history | Overlapping claim, different architecture — revised 2026-08-24; the "zero public repos" framing above is stale. OpenWork now ships a live on-chain agent marketplace (an `OpenworkEscrow` contract, a `$OPENWORK` token on Base, wallet-based agent identity, competitive job bidding) — a crypto-native, on-chain-settlement design, versus INAM's off-chain, settlement-agnostic reference receipts. No independently verifiable usage/volume data was found for it beyond its own site's feature claims, so treat "launched a token and an escrow contract" as a real architecture, not confirmed traction. Note: an unrelated desktop-agent product also uses the "OpenWork" name (e.g. `different-ai/openwork`, `modelstudioai/openwork` on GitHub) — do not conflate the two when researching this row further. |

## 12. Verification (independent attestation)

A receipt's `verification.method` (§4.1) can be `independent_validator` or `test_suite_pass`, but until now neither had any enforcement behind it — a receipt could claim either value with nothing checking it. This section adds a **Verification** resource: a third party's signed attestation that a specific finalized receipt's output actually satisfies its job's requirements. It sits after Receipt in the chain, not inside it:

```
Job → Execution → Receipt (finalized) → Verification → verified / rejected
```

**v0.1 is deliberately narrow.** Locked for this version — not because these are bad ideas, but because shipping all of them at once is how a spec ends up with untested corners: single verifier per receipt (no multi-verifier consensus), `provider != verifier` strictly enforced (no exceptions), only `deterministic` and `agent_attestation` methods, no new dispute mechanism, no verifier-side reputation, no external-registry passthrough (OpenWork/AgentPass/etc. attestations). Multi-verifier consensus, `human_attestation`/`external_attestation`, and verifier reputation are the explicit v0.2 backlog (§12.7) — a registry **MUST NOT** need any of them to conform to this version.

### 12.1 Shape

```json
{
  "verificationVersion": "1.0",
  "verificationId": "sha256:<hex>",
  "receiptId": "sha256:...",
  "jobId": "job_7f31c2",
  "provider": "did:key:z...",
  "verifier": "did:key:z...",
  "method": "deterministic",
  "outputHash": "sha256:...",
  "result": "verified",
  "score": 0.98,
  "evidenceUri": "https://...",
  "createdAt": "2026-08-22T15:00:00Z",
  "signature": "base64..."
}
```

`provider` and `jobId` are not independently supplied by the caller — a registry **MUST** derive both from the referenced `receiptId` (`provider` = that receipt's `agentB.id`, `jobId` = that receipt's `jobId`) rather than trusting client-asserted values that could disagree with the receipt itself. `outputHash` **MUST** match the referenced receipt's `result.outputHash` exactly — a registry **MUST** reject a mismatch with `VERIFICATION_TARGET_MISMATCH` rather than silently accepting an attestation about different output than what the receipt actually recorded. `evidenceUri` is optional and, like `outputUri` on a receipt (§4.1), a pointer, not a payload — same "carry the proof, not the data" principle as the rest of the spec. There is no separate `requirementsHash`: the job's own `specHash` (§3.1) is what the verifier is expected to have checked the output against.

`method` is one of `deterministic` (an automated test/check ran and produced a pass/fail) or `agent_attestation` (another agent examined the work and attests to it) — a registry **MUST** reject any other value with `UNSUPPORTED_VERIFICATION_METHOD` in this version. `result` is `verified` or `rejected` — the verifier's own signed judgment, recorded either way; a rejected verification is not an error, it's a legitimate, queryable attestation that the work did not hold up. `score` is optional, `0..1`, a confidence/quality signal a registry **MAY** ignore.

### 12.2 Verification ID (content addressing)

```
verificationId = "sha256:" + hex(sha256(canonical({
  receiptId, jobId, provider, verifier, method, outputHash, result, score, evidenceUri
})))
```

The signed content is this same set of fields plus `verificationVersion` and `verificationId` itself (the already-computed hash) — i.e. `signature = Ed25519(canonical({ verificationVersion: "1.0", verificationId, receiptId, jobId, provider, verifier, method, outputHash, result, score, evidenceUri }), verifierPrivateKey)`, mirroring exactly how a receipt's signed content embeds its own `receiptId` alongside the fields that were hashed to produce it (§4.1–§4.2). `createdAt` is server-assigned metadata, not part of the signed content — there's no window or reactivation logic here that depends on it the way a receipt's `dispute.windowClosesAt` does.

Same content-addressing principle as a receipt (§4.2): the id is derived from the content, not assigned. A registry **MUST** treat a resubmission of byte-identical content as `DUPLICATE_VERIFICATION`.

### 12.3 Creating a verification

**`POST /verifications`** *(signed, caller MUST be the `verifier`)*. Unlike a receipt, a verification has no draft/countersign step — it's a single party's attestation, signed once, complete on submission. A registry **MUST** validate, in order, before accepting:

1. The referenced `receiptId` exists and is `status: "finalized"` (§4.3) — **MUST** reject with `RECEIPT_NOT_FINALIZED` otherwise. Verifying a `draft` receipt makes no sense (it isn't reputation-eligible yet); verifying a `disputed` one is handled by §12.4 below, not by rejecting the request outright.
2. The request's own INAM signature (§7) is by the same ID as `verifier` in the submitted content — **MUST** reject a mismatch with `NOT_VERIFIER`.
3. `verifier` is not equal to `provider` (the receipt's `agentB.id`) **or** `requester` (the receipt's `agentA.id`) — **MUST** reject a self-verification attempt from either party with `SELF_VERIFICATION`. This is the core collusion guard: without excluding *both* parties, either could rubber-stamp the work the receipt already records them agreeing on (v0.5 excluded only the provider — the requester, who already approved the same work by countersigning it, was left able to name itself "independent verifier" with no check at all).
4. `verifier` is a registered agent (§2) **and** has been explicitly authorized as a verifier by the registry's operator identity (v0.10 — see §2, §12.6) — **MUST** reject an unregistered `verifier` with `AGENT_NOT_FOUND`, and **MUST** reject a registered-but-unauthorized `verifier` with `VERIFIER_NOT_AUTHORIZED`. Being merely registered is not sufficient: registration is free and self-service, so "verifier is a registered agent" alone never restricted who could verify, only that they'd taken the zero-cost step of registering first — it made verifier *count* meaningless as an independence signal (an audit found this directly undermines §12.5's verified-vs-rejected tiebreak, which assumes each verifier represents a real, distinct grant of trust). Authorization is the actual gate; registration is just a prerequisite for it. This still does not establish that the verifier is a genuinely independent legal or organizational entity — no cryptographic scheme can, on its own (see §0's boundary: identity/authorization is explicitly not this protocol's job) — only that the registry operator has deliberately vouched for this specific identity as a verifier, rather than anyone being able to claim that status for themselves.
5. `outputHash` matches the receipt's `result.outputHash` — **MUST** reject a mismatch with `VERIFICATION_TARGET_MISMATCH` (§12.1).
6. `method` is a supported value (§12.1).
7. The `signature` verifies against `verifier`'s Ed25519 key over the canonical bytes of the content in §12.2 (including `verificationVersion` and `verificationId`, excluding `signature` itself) — **MUST** reject with `INVALID_VERIFICATION_SIGNATURE` otherwise. Same canonicalize-then-sign discipline as a receipt, reusing the identical `canonicalize()`/Ed25519 primitives (§4.2, §8); this version introduces no new signing scheme.
8. A resubmission of byte-identical content (same `verificationId`) — **MUST** reject with `DUPLICATE_VERIFICATION` rather than creating a second record, same principle as a receipt (§4.2). Checked before rule 9: an exact resubmission is a harmless no-op (e.g. a client retrying after a dropped response) and **MUST** be reported as such, distinct from actually attempting a second, different decision.
9. This `verifier` has not already submitted a verification for this `receiptId` (regardless of content) — **MUST** reject a second, differently-shaped decision from the same verifier with `VERIFIER_ALREADY_DECIDED`. Without this, the same verifier could submit `verified` and, separately, `rejected` for the same receipt — different content means rule 8's content-hash check doesn't catch it — leaving both as live, contradictory records with no way to tell which is authoritative. A registry **MUST NOT** interpret this as a way to "update" a decision; a verifier's first decision for a receipt is final in this version (multi-verifier consensus / decision supersession is explicit v0.2 backlog, §12.7).

A registry **MUST** create the record with whatever `result` the verifier signed (`verified` or `rejected`) once all checks pass — a registry **MUST NOT** substitute its own judgment for the verifier's. Response `201` with the full record.

### 12.4 Relationship to Receipt disputes — no new dispute mechanism

This version deliberately does **not** add a second dispute concept. A receipt's existing `dispute` state (§4.3) is the only dispute mechanism in the protocol; Verification does not get its own.

- A registry **MUST** check the referenced receipt's *current* `status` before letting a `verified` Verification contribute to reputation (§12.5) — if the receipt is `disputed`, it stays excluded from the positive side of the reputation calculation exactly as §4.3 already requires, regardless of any Verification referencing it. A verified Verification does **not** resurrect a disputed receipt.
- Disputing a receipt does **not** retroactively delete or invalidate an existing Verification record — it stays queryable as historical evidence (what a verifier attested, and when), only its effect on reputation is suppressed while the receipt remains disputed. If the dispute is later resolved (§4.3 — the opener withdraws it, moving the receipt back to `finalized`), the Verification's contribution resumes automatically, since the check in §12.5 is computed live from current receipt status, not cached at verification-creation time.
- A `rejected` Verification does **not** automatically open a dispute on the receipt in this version — a registry **MUST NOT** infer an automatic state transition on the receipt from a Verification result. A rejected Verification is evidence a receipt's own parties (or a future version of this spec) could act on; auto-disputing on rejection is explicit v0.2 backlog (§12.7).

### 12.5 Reputation linkage

No new event stream (§5.1's reasoning applies equally here: a second parallel ledger is a second source of truth waiting to drift). Instead, `computeReputation` (§5.2) **MUST** apply an additional weight multiplier to a finalized, non-disputed receipt whose independent-verification evidence **nets out to verified** — a registry **MAY** choose its own multiplier (the reference implementation uses a fixed boost; see `src/services/reputationService.ts`), but **MUST** apply it consistently in the same direction (independently-verified work counts for more, never less). A `rejected` Verification **MUST NOT** apply any weight change of its own in this version (no direct penalty) — it's recorded and queryable, but individually scoring-neutral; a future version may change this (§12.7).

"Nets out to verified" (v0.9, tightened from v0.1's "at least one `verified` Verification exists"): a registry **MUST** count both `verified` and `rejected` Verifications referencing the receipt and **MUST NOT** apply the boost unless verified strictly outnumbers rejected. §12.3 places no limit on how many *different* verifiers may independently verify the same receipt (only §12.3 rule 9 stops one verifier from being inconsistent with itself), so multiple verifiers reaching different conclusions is a real, reachable state — an audit found the original at-least-one rule let a single `verified` grant the boost regardless of how many independent verifiers rejected the same receipt, a real exploit for the receipt's own parties (get one colluding or careless verifier to say `verified`), not merely an unbuilt feature. This is a narrow anti-exploit tiebreak, not the multi-verifier consensus mechanism §12.7 still defers to v0.2 — no verifier-trust weighting, no quorum, no new state, and the common single-verifier case (`verified`, zero `rejected`) is unaffected.

A registry **MUST** additionally report an `attestedReceipts` count in the reputation response `components` (§5.3) — the number of an agent's finalized receipts whose Verification evidence nets out to verified per the above — so the boost is auditable rather than folded invisibly into `trustScore`, same principle as every other component.

### 12.6 REST API additions

| Method & path | Description |
|---|---|
| `POST /verifications` *(signed, caller = verifier)* | Submit a signed verification of a finalized receipt (§12.3). |
| `GET /verifications/:id` | Fetch a single verification. |
| `GET /receipts/:id/verifications` | List verifications referencing a receipt. |
| `POST /agents/:id/verifier-status` *(signed, caller = operator only)* (v0.10) | Grant or revoke `:id`'s `isAuthorizedVerifier` flag (§2, §12.3 rule 4). Body: `{ "authorized": true \| false }`. Response `200` with the full updated agent record. |

New error codes: `RECEIPT_NOT_FINALIZED`, `NOT_VERIFIER` (the request isn't signed by the `verifier` it names), `SELF_VERIFICATION` (as of v0.6, either party to the receipt — not just the provider), `VERIFICATION_TARGET_MISMATCH`, `UNSUPPORTED_VERIFICATION_METHOD`, `INVALID_VERIFICATION_SIGNATURE`, `DUPLICATE_VERIFICATION`, `VERIFICATION_NOT_FOUND`, `VERIFIER_ALREADY_DECIDED` (v0.6), `VERIFIER_NOT_AUTHORIZED` (v0.10 — registered but not operator-authorized, §12.3 rule 4), `NOT_OPERATOR` (v0.10 — caller of `POST /agents/:id/verifier-status` is not the registry's configured operator identity). `AGENT_NOT_FOUND` (already defined for other resources, §2) now also applies here (v0.6): an unregistered `verifier`.

**The operator identity itself is deployment configuration, not a protocol-defined identity.** A registry **MUST** designate exactly one `did:key` as its operator (reference implementation: `INAM_OPERATOR_DID` env var, Node; `OPERATOR_DID` binding, Worker) and **MUST** treat it as unset by default — a registry with no operator configured **MUST** reject every `POST /agents/:id/verifier-status` call with `NOT_OPERATOR` (nobody is authorized to authorize) rather than falling open. This spec does not define operator succession, multi-operator setups, or key rotation for the operator identity itself — a single static operator key is the deliberately narrow v0.10 scope; anything beyond that is future work, same spirit as §12.7's other deferrals.

### 12.7 Explicitly deferred (v0.2 backlog)

Not omitted by accident — deferred because shipping them alongside v0.1 would mean testing multiple new state spaces at once instead of proving one solid primitive first:

- **Multi-verifier consensus** (`min_verifiers`, agreement-threshold policy) — v0.1 is exactly one verifier per verification; a job/receipt needing stronger assurance can accumulate multiple independent `POST /verifications` calls from different verifiers today (nothing prevents that), but a registry has no obligation to compute consensus across them yet.
- **`human_attestation` / `external_attestation` methods** — including any passthrough for another system's own attestation (OpenWork, AgentPass, a cloud provider, etc.) verifying the work instead of an INAM-native verifier.
- **Verifier-side reputation** — a verifier accumulating its own track record (agreement rate with eventual disputes, volume, etc.) as a second reputation dimension distinct from provider reputation.
- **Auto-dispute on rejection** — a `rejected` Verification automatically opening a receipt dispute rather than sitting as inert evidence (§12.4).

None of the above are needed for a registry to conform to this version. What is **not** deferred, unlike the list above: cross-runtime interop is a first-class v0.1 requirement, same as §8 — a verification signed by any conforming SDK in any language **MUST** verify identically against any conforming runtime. This is the acceptance bar that makes §12 a real protocol addition rather than one implementation's local feature: Node-created → Worker-verified, Worker-created → Python-verified, Python-created → Node-verified, all three producing byte-identical `verificationId`s for the same content.
