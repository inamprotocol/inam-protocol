---
title: "How to verify an AI agent before you pay it"
description: "Your agent is about to pay another agent or an x402 API it found in a directory. Four checks to run first: who it is, whether the wallet belongs to it, whether it has delivered before, and what to do when the answer is unclear. With code."
date: 2026-10-09
---

Agents now pay each other. An x402 API answers `402 Payment Required` with a wallet and a price, and the calling agent pays in one retry. Marketplaces let one agent hire another. The payment part works. What the paying agent usually lacks is any reason to pick this seller over the next one.

In our [Agent Trust Index #1](/blog/agent-trust-index-2026-10) we read 18,872 x402 Bazaar listings. None of the 808 payout wallets was tied to a verifiable track record, and 13% of sampled sellers pointed at nothing. Here is what to check before money moves.

## 1. Who is it?

Find a stable identifier for the seller: a `did:key`, an ERC-8004 agent ID, or an A2A Agent Card that names one. A domain name alone is weak, since domains change hands and a listing can point anywhere.

If you need to know the legal operator behind the agent, that is a Know Your Agent question, and identity providers answer it. For most agent-to-agent calls, a cryptographic identifier that persists across jobs is the minimum.

## 2. Does the wallet belong to it?

This is the check most payers skip. A seller can claim any name. What matters is whether the wallet you are about to pay is controlled by the same party as the reputation you looked up.

INAM handles this with a wallet link: the agent signs a challenge with its payout wallet, and the registry records it as `linked.erc8004_id`. The x402 gate then compares that address with the `payTo` in the 402 response and refuses on a mismatch. Without this step, a seller with no history can borrow the name of one with a good history.

## 3. Has it delivered before?

Look at its work history, not just a score. In INAM, each finished job is a receipt signed by both sides, and the reputation response tells you how strong the evidence is:

- `evidenceLevel`: `none`, `countersigned` or `independently_verified`.
- `trustScore`: a number computed from those receipts.
- `flags`: warnings such as `in_dispute` or `concentrated_counterparty` (most of its work is with a small group of counterparties, a typical fake-history pattern).

```
curl https://api.inamprotocol.org/v1/agents/<did>/reputation
```

For a larger job, open the receipts themselves (`/v1/agents/<did>/receipts`) and check who the counterparties were.

## 4. Decide: pay, hold, or walk away

Not every unknown seller is bad. New agents have to start somewhere. So the useful answer is often not yes or no, but "pay on delivery." `checkTrust` in the JS SDK (and `check_trust` in Python) returns one of three decisions with the reasons:

```ts
import { InamClient, generateKeypair, checkTrust } from "inamprotocol";

const client = new InamClient("https://api.inamprotocol.org", generateKeypair());
const d = await checkTrust(sellerDid, client, {
  allow: { minEvidence: "countersigned", minTrustScore: 2 },
  escrow: { minEvidence: "none" },
});
// d.decision: "allow" | "escrow" | "deny", d.reasons: [...]
```

- `allow`: pay upfront.
- `escrow`: deal, but hold the payment until delivery is confirmed, or keep the first job small.
- `deny`: revoked, unknown, or below your floor.

The thresholds are yours. The registry's numbers are a hint, and the policy runs on your side.

## Doing it automatically for x402

If your agent pays x402 APIs, wrap its fetch once and every payment runs the checks above first:

```ts
import { withInamX402Gate } from "inamprotocol";

const safeFetch = withInamX402Gate(paidFetch, client, { minEvidence: "countersigned" });
```

The gate reads the seller's INAM ID from the 402 response, checks that the `payTo` wallet is the one the ID linked, applies your policy, and only then lets the payment through. The full walkthrough, tested with real USDC on Base Sepolia, is in [x402: verify an agent before you pay it](/blog/x402-verify-before-you-pay).

For agents that hire other agents over A2A, `verifyA2ACard` does the same with an Agent Card. In the Vercel AI SDK, [`inamTools()`](/blog/vercel-ai-sdk-agent-reputation-tools) gives the model these checks as tools.

## And after you pay

Countersign the receipt. If you use `inamFetch` against a seller that runs `inamReceipts`, it happens automatically when the bytes match. That one signature is what turns today's unknown seller into the next payer's evidence.
