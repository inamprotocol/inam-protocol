# Verification v0.2 backlog — design sketch

Scoping aid, not a spec. Extends SPEC.md §12 (Verification, v0.1: single verifier, `provider != verifier`, `deterministic`/`agent_attestation` only, no new dispute mechanism, reputation via weight multiplier). Nothing here is implemented or committed to.

## 1. Multi-verifier consensus

**Job-level policy field.** Add optional `verificationPolicy` to Job (§3.1), not Receipt — the requester sets assurance requirements when posting, not after the fact:

```json
"verificationPolicy": { "minVerifiers": 2, "agreementThreshold": 0.66 }
```

Absent policy = today's v0.1 behavior (any single `verified` Verification counts). This is additive to Job's shape, same pattern as `budget` — informational, not enforced by transport.

**Aggregation.** No new resource. `GET /receipts/:id/verifications` already returns all Verification records for a receipt; consensus is a *read-side computation* over that list, not a stored aggregate — avoids a second source of truth (same reasoning SPEC.md gives for not having a separate reputation-event ledger). `computeReputation` would need to know the *originating job's* policy to interpret a receipt's verifications correctly, which means either denormalizing `verificationPolicy` onto the receipt at finalize time (receipt already copies `task.specHash` from the job it was drafted against — same precedent) or accepting a join through `receiptId → jobId → job.verificationPolicy` at read time. Denormalizing is simpler and keeps the receipt self-contained for reputation computation, consistent with why receipts already snapshot job data rather than referencing it live.

**Open question the real design must answer:** does a receipt need *consensus reached* to earn any boost, or does a single `verified` still count partially with a scaling factor toward full boost at threshold? Partial credit is more expressive but reopens gaming risk (a provider recruiting one friendly verifier for partial credit instead of zero). Recommend: no boost until `agreementThreshold` of *all verifications submitted so far* are `verified` — a receipt with 1 `verified` + 1 `rejected` under `minVerifiers: 2` gets nothing until a third resolves it, not half.

**API delta:** none required beyond the Job field — `POST /verifications` stays exactly as v0.1 (each verifier submits independently); only the reputation *computation* reads the policy.

## 2. `human_attestation` / `external_attestation`

Two different problems wearing one name.

**`human_attestation`** is easy: it's `agent_attestation` with a human behind the signing key instead of an agent process. No schema change — v0.1's `method` enum already has a slot for it; the only reason it isn't in v0.1 is to keep the method list minimal, not because it needs new mechanics. Cheapest v0.2 add.

**`external_attestation`** is the hard one, and worth being honest about why: v0.1's whole trust model rests on INAM verifying an Ed25519/P-256 signature it fully controls the semantics of. An external system's attestation (OpenWork, AgentPass, a cloud provider) comes in *that system's* proof format — INAM can't verify it with the same code path without either (a) hardcoding a parser per external system (an adapter, unbounded surface area, and INAM starts vouching for formats it doesn't own — the exact anti-pattern the AITP link-challenge work in §2.1 was careful to avoid, "best-effort alignment, not a certification claim"), or (b) storing the external proof as opaque evidence (`evidenceUri` + `evidenceHash`, already expressible in v0.1's shape) without INAM cryptographically verifying it at all — demoting `external_attestation` from "verified fact" to "claimed provenance," same trust level as `outputUri` today. (b) is more honest and requires zero new verification code; it just needs a `method: "external_attestation"` value and an `externalSource` field (`"openwork"`, `"agentpass"`, freeform) — but then it **must not** contribute to the reputation boost the same way a cryptographically-checked `verified` does, or INAM is silently laundering unverified trust into its own score. Recommend treating `external_attestation` as evidence-only (visible, queryable, zero reputation weight) unless/until INAM actually integrates a specific external verifier's public verification API — at which point it becomes its own first-class `method`, not a generic passthrough.

## 3. Verifier-side reputation

Second function, not a variant response shape: `computeVerifierReputation(verifierId)`, separate from `computeReputation` (provider-side). Reason to keep them separate rather than merging into one agent profile: an agent's provider-trust and verifier-trust measure different failure modes (does their *own* work hold up vs. do their *judgments about others'* work hold up) and conflating them lets a bad provider launder trust by doing a lot of (easy, unaccountable) verifying, or vice versa. A single agent profile can carry both scores as sibling fields — `GET /agents/:id/reputation` gaining an optional `asVerifier` block when the agent has any Verification records — without needing a separate resource or endpoint.

**Signal set:** verification volume (how many issued), and — the one that actually requires new plumbing — *agreement rate with eventual outcomes*: did a receipt this verifier marked `verified` later get disputed (§4.3) and, if a future version defines dispute resolution outcomes, lose? Without a resolution outcome to check against (v0.1 doesn't define one — §12.4 explicitly punts on it), the only honest v0.2 signal is "disputed-after-verified rate" as a negative indicator, not a definitive accuracy measure. Response latency (time from receipt-finalized to verification-submitted) is a weaker, gameable-by-speed signal — lower priority.

**Collusion risk, reopened.** Exactly the wash-trading shape §5.2 already guards against for provider↔counterparty pairs (`log(pairCount)/pairCount` sub-linear weighting), needed again for provider↔verifier pairs: a provider and a friendly verifier trading `verified` attestations back and forth would otherwise farm both reputations simultaneously. Reuse the existing pair-weighting function against the `(provider, verifier)` pair rather than inventing new math — same shape as the counterparty-concentration flag in §5.2, applied to a second relationship axis.

## Phase 5/6 readiness

Phase 5 (payments/stake) and Phase 6 (marketplace) are correctly untouched — SPEC.md §10 lists payment/settlement enforcement and stake posting/slashing as explicitly out of scope, and nothing in Verification v0.1 changes that boundary. `score` (0..1 confidence) and `attestedReceipts` are reputation/discovery signals only; neither is a payment primitive, and using them as one (e.g. auto-releasing an escrowed payment on `verified`) would be a Phase 5 decision layered *on top of* Verification, not a natural extension of it — Verification's job is to make "this work is good" checkable, not to move money on that basis.

The one real prerequisite Phase 5 has that's still unresolved and **not this session's decision**: which payment rail (x402, AP2, on-chain, something else) INAM's `settlement.paymentRef` actually points at. SPEC.md deliberately keeps that a reference field with no enforced scheme. Picking one is a product/business decision with real lock-in consequences, not a technical scoping question — premature to make it just because Verification now gives reputation a stronger signal to hang a payment decision on.
