# Economic layer v0.1 scoping — Phase 6 prep

Status: **not decided, not started.** This is a scoping aid for the payment-rail conversation STATUS.md gap #5 flags as needed before any Phase 6 code gets written — it lays out the decision and its tradeoffs, it does not make the decision. Nothing here is implemented or committed to. No code changes accompany this document.

(Numbering note: STATUS.md's phase table currently lists this as "Phase 5 — Economic layer" with "Phase 6 — Network/marketplace" after it; SPEC.md's own phase list elsewhere in the project has used "Phase 6" for the economic layer. This doc uses "the economic layer" and avoids the number where it would be ambiguous — check STATUS.md's phase table for whichever numbering is current before referencing this doc externally.)

## 1. What already exists to build on

The data model already has three fields shaped for this, all currently inert:

- **`settlement`** on a finalized Receipt (SPEC.md §4.1): `{ "paymentRef": "x402:tx_88a1", "amount": "12.50", "currency": "USDC" }`. `paymentRef` is a free-form string — the example value hints at x402 shape (`scheme:opaque-id`) but nothing enforces that format, validates it, or resolves it against anything. It is recorded, hashed into the receipt's content-addressed id (§4.2), and never read back by any verification logic.
- **`budget`** on a Job (§3.1): `{ "amount": "12.50", "currency": "USDC" }`. SPEC.md is explicit: "`budget` is informational only; a registry MUST NOT treat it as a payment commitment." Nothing checks that a receipt's eventual `settlement.amount` matches the job's `budget`, or that it even exists.
- **`stakeUsd`** on an Agent (§2): a plain number, defaults to `0`, feeds directly into the reputation formula (`sqrt(stakeUsd)` term, `src/services/reputationService.ts` lines 42 and 110 — both the counterparty `baseTrust` estimate and the agent's own `trustScore`). The formula has depended on this field since before Verification v0.1 shipped.

What's genuinely missing, not just unfinished:

- **No endpoint to post or slash stake.** `stakeUsd` can currently only ever be `0` for every agent in every deployment, because nothing writes to it. This is stated plainly in README.md's "Deliberate simplifications" section and SPEC.md §10.
- **No settlement confirmation flow.** There's no mechanism by which a registry learns that the money referenced by `paymentRef` actually moved, moved for the right amount, or moved between the right parties. `POST /receipts` and `POST /receipts/:id/countersign` accept whatever `settlement` object the caller signs — a receipt with `settlement.paymentRef: "totally-fake"` is exactly as valid, by the protocol's own rules, as one referencing a real, verifiable transaction.
- **`paymentRef` is opaque and unenforced by design, not by oversight.** SPEC.md §10 lists "Payments/settlement enforcement" as explicitly out of scope: "`settlement` and a job's `budget` are recorded but never verified against x402/AP2/on-chain state." §11's protocol-relationship table says the same thing from the other direction: "`settlement.paymentRef` ... [is] designed to hold a reference into one of [x402/AP2/ACP]; INAM does not move money itself." This is the load-bearing design fact for everything below — INAM currently claims no opinion about what `paymentRef` points at, and that absence of an opinion is itself the current design, not a placeholder waiting to be filled reflexively.

## 2. The real decision

The question is not "should INAM support payments" — `settlement` and `budget` already assume some rail exists. The question is: **does INAM pick a specific rail (or small set of rails) to actually understand and verify, or does it stay a passive reference field indefinitely?** Below are the live options, described honestly, with what INAM would need to build and trust for each, and who it attracts or repels. This section does not rank them.

### Option A — x402 (HTTP-native micropayment scheme)

What's actually known, not invented: x402 is an HTTP-based micropayment protocol (built around the reused HTTP 402 status code) designed for agent-to-agent and agent-to-service machine payments, originating from Coinbase-adjacent work and associated in its early materials with stablecoin/on-chain settlement (USDC being the commonly cited example). It's designed to be checked programmatically as part of an HTTP exchange rather than requiring a human checkout flow. Beyond that shape, this document does not claim detailed knowledge of x402's current wire format, its maturity/adoption state as of this writing, or its governance — that would need to be verified against its current spec before being relied on for real integration work, not assumed from the name recognition alone.

- **What INAM would need to build:** an x402 client/verifier component that can check a `paymentRef` actually corresponds to a settled x402 payment — i.e., call out to whatever x402 uses as its settlement/facilitator layer and confirm state, not just accept the string.
- **What it would need to trust/depend on:** x402's facilitator/settlement infrastructure and its underlying chain's finality guarantees; x402's own spec stability, since INAM would be coding against its wire format.
- **Who it attracts:** agents and services already comfortable transacting in stablecoins over HTTP — likely the same population building against MCP/A2A-style tool-calling agents, since x402 is explicitly aimed at that machine-to-machine use case. Likely a good philosophical fit with INAM's own "agents running anywhere, verified after the fact" framing.
- **Who it repels:** any adopter whose organization can't or won't touch on-chain/stablecoin rails at all (regulated industries, some enterprise procurement, jurisdictions with restrictions) — this option inherits every constraint that comes with stablecoin settlement generally.

### Option B — AP2 (Google's Agent Payments Protocol)

Flagging uncertainty explicitly, as instructed: this document does not have verified, current knowledge of AP2's actual specification — its message shapes, its settlement model, whether it's rail-specific (e.g. tied to particular payment processors) or rail-agnostic, its maturity, or its governance. What's known only at the level of public positioning: Google has published something under the name "Agent Payments Protocol" (AP2) aimed at giving AI agents a standardized way to initiate and authorize payments, with mandate/authorization concepts distinguishing "agent proposes" from "human/principal approves." Anything more specific than that should be verified against AP2's current published spec before being used to inform a real decision — this doc should not be treated as an authority on what AP2 actually does.

- **What INAM would need to build:** unknown without that verification — likely an integration against whatever AP2's authorization/mandate and settlement-confirmation APIs turn out to be.
- **What it would need to trust/depend on:** unknown — plausibly Google's own infrastructure or a broader multi-processor consortium, depending on how AP2 is actually architected. This is exactly the kind of dependency that needs to be nailed down, not guessed at, before treating AP2 as a candidate.
- **Who it attracts / repels:** unknown with confidence; worth noting only that a Google-originated protocol carries different adoption dynamics (credibility with enterprise/traditional-rail adopters, possible platform lock-in concerns for a "neutral, open" protocol like INAM positions itself as in SPEC.md §0) than a smaller, more crypto-native effort like x402. That tension — INAM's own positioning as neutral infrastructure vs. adopting a large single-vendor-originated payment protocol — is itself worth surfacing in the eventual scoping conversation regardless of AP2's technical merits.

### Option C — Direct on-chain / stablecoin settlement (USDC-style)

Not necessarily "x402" specifically — the more general version: INAM defines its own minimal expectation for `paymentRef` (e.g. "a transaction hash on chain X, verifiable via public RPC") without adopting a full third-party payment protocol's message format. SPEC.md's own example (`"currency": "USDC"`, `settlement.paymentRef: "x402:tx_88a1"`) already leans this direction, and `budget.currency` in the Job example is `"USDC"` too — the current examples in the spec are not neutral; they're already suggestive of a stablecoin-first mental model even though nothing enforces it.

- **What INAM would need to build:** a lightweight verifier that checks a transaction hash resolves on the stated chain, moved the stated amount, between wallet addresses that map to the two agents' identities (which itself requires deciding how an Ed25519 `did:key` INAM ID maps to an on-chain wallet address — a real open sub-problem, not solved by picking this option).
- **What it would need to trust/depend on:** a public chain's RPC infrastructure/finality, and a stablecoin issuer's peg/redemption guarantees (Circle for USDC, or whichever issuer). Much lighter-weight than adopting x402 or AP2 as a full protocol — no facilitator/authorization layer, just settlement-fact verification.
- **Who it attracts:** on-chain-native agent builders, crypto-payments-comfortable adopters — a strict subset of Option A's audience, since it skips whatever value-add x402 provides beyond raw settlement checking (e.g. facilitator discovery, request/response payment negotiation).
- **Who it repels:** exactly the same population Option A repels, for the same underlying reason (chain/stablecoin dependency) — anyone excluded from on-chain rails at all is excluded here too. Also repels adopters who want the negotiation/discovery conveniences a fuller protocol like x402 provides and would find "just check a tx hash" too primitive to build real payment flows on.

### Option D — Stripe / traditional-rail-as-adapter

Treat `paymentRef` as potentially pointing at a traditional payment processor's transaction/charge ID instead of (or alongside) an on-chain reference — e.g. `"stripe:ch_1AbC..."`.

- **What INAM would need to build:** a Stripe (or similar) API integration to confirm a charge/transfer's state, likely requiring the registry operator to hold Stripe API credentials scoped to check (not initiate) transactions.
- **What it would need to trust/depend on:** Stripe's (or whichever processor's) own infrastructure, uptime, and API stability; and critically, whichever party's Stripe account the transaction ran through — this option is the most likely to reintroduce a "whose account is this" question that on-chain settlement sidesteps by being account-less.
- **Who it attracts:** adopters already embedded in conventional fiat/card-rail commerce — enterprises, regulated businesses, anyone for whom "pay with a stablecoin" is a nonstarter internally.
- **Who it repels:** autonomous on-chain agents with no fiat on/off-ramp, no corporate entity to hold a Stripe account, or operating in a context where opening a traditional merchant/processor account isn't feasible (exactly the audience Option A/C attract). This is close to a mirror image of Options A/C's exclusion pattern.

### Option E — Stay payment-agnostic longer

Keep `paymentRef` exactly as it is today: an opaque, unenforced string. Do not pick a rail. Let the ecosystem settle on one (or several) before INAM commits engineering effort to verifying any of them.

- **What INAM would need to build:** nothing new. This is the status quo, made deliberate rather than default.
- **What it would need to trust/depend on:** nothing new — but it also means INAM's reputation signal never incorporates a settlement-verified economic-volume signal; `volumeUsd` in the reputation `components` (§5.3) already sums `settlement.amount` today (`reputationService.ts` line 102) from self-reported, unverified receipt data. That's already true right now regardless of which option is eventually picked — worth naming explicitly, since it means "stay agnostic" is not risk-free, it's a continuation of an existing soft spot.
- **Who it attracts:** nobody is repelled by this option specifically — it's maximally permissive. Its risk is different in kind: adopters who need enforced settlement guarantees for a real product will look elsewhere or build their own layer on top, so extended agnosticism risks INAM becoming irrelevant to exactly the use case that most wants Phase 6, rather than actively excluding anyone.

## 3. What INAM should almost certainly not do, regardless of which rail is picked

- **Become a money transmitter.** `settlement.paymentRef` is designed, today, as "a reference to money that moved elsewhere" — SPEC.md §11 states this outright ("INAM does not move money itself"). Every option above preserves that: verifying a settlement fact (did money move, per the rail's own source of truth) is a fundamentally different, much lower-liability act than routing or holding money. Crossing that line invites money-transmitter licensing obligations in most jurisdictions that a reference-checking registry does not have.
- **Hold custody of funds.** No escrow, no "INAM holds the payment until work is verified" flow. That's a real, common pattern in marketplace design (and is implicitly what an over-eager reading of §12's Verification resource might suggest — e.g. "auto-release escrow on `verified`," which the Verification v0.2 backlog document explicitly flags as a Phase 5-layered decision, not a natural extension of Verification). Custody is a different business (and different regulatory category) than a reputation/verification registry, and nothing in the current data model implies INAM ever intended to hold funds — `paymentRef` only ever references settlement that happened somewhere else.
- **Silently pick a rail by default.** STATUS.md gap #5 already names this risk directly: "worth a scoping conversation before any Phase 5 code gets written, not something to default into." The existing SPEC.md example values (`x402:tx_88a1`, `USDC`) are illustrative, not a decision already made by omission — this doc exists partly to make sure that isn't misread as tacit direction.

## 4. Is there a minimal first slice, decoupled from the rail decision?

Asked honestly, not rhetorically: **is stake posting/slashing separable from picking a settlement rail for `settlement.paymentRef`?**

The two are more coupled than they look at first glance, but not identically coupled:

- **Stake posting** (an agent deposits some amount, `stakeUsd` gets set to a real, non-zero, backed number) is not inherently rail-specific — an agent could stake by locking USDC in a specific on-chain contract, or by a traditional processor hold, or by any other mechanism INAM chooses to trust for this one purpose. In principle a registry could pick a *narrow* answer for staking specifically ("stake is posted as USDC on chain X, verified via a simple balance/lock check") without having settled the *general* `settlement.paymentRef` rail question for every receipt's payment. This is the closest thing to a genuinely separable slice.
- **Stake slashing**, however, reopens the coupling immediately: slashing requires a dispute-resolution authority to decide *when* a slash is warranted, and INAM's current dispute mechanism (§4.3) is deliberately thin — either party can open a dispute, there's no resolution/arbitration step defined anywhere in the spec (§4.3's own text notes a "resolved" reactivation path isn't defined either). Slashing without a resolution authority is either unenforceable (nothing ever triggers it) or requires INAM (or someone) to become exactly the kind of arbiter/custodian the "almost certainly not" list above warns against. Posting is a deposit; slashing is a judgment call about someone else's money, which is a fundamentally heavier decision than posting.
- **Honest answer:** *partially* separable, not cleanly. Stake **posting** could plausibly move as a small first slice using a narrow, single-mechanism choice (e.g. "stake is USDC on-chain, verified by a simple balance check, nothing fancier") without having resolved the general payment-rail question — this is close to Option C's minimal on-chain verifier, applied only to the stake field, not to every receipt's `settlement`. Stake **slashing** should not be treated as part of that same minimal slice — it depends on dispute-resolution machinery that doesn't exist yet and that this document is not the place to design. If the maintainer wants a genuinely minimal first move, "posting only, no slashing yet" is the honest boundary, not "the whole stake endpoint."

This is not a recommendation to build even that slice now — it's an answer to the specific question of whether the coupling is total (it isn't, for posting) or whether stake and general settlement are one monolithic decision (they mostly are, once slashing enters the picture).

## 5. Explicitly not decided, not started

Every option above is described, not chosen. No `POST /agents/:id/stake` endpoint, no settlement verifier, no rail-specific integration code exists anywhere in this repository as of this document. This document does not modify SPEC.md, STATUS.md, or any source file — it exists so the scoping conversation STATUS.md gap #5 calls for has groundwork laid out in advance, not so that conversation is preempted.
