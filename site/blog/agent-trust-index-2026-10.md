---
title: "Agent Trust Index #1: how many x402 Bazaar sellers have a track record?"
description: "We read a full x402 Bazaar discovery list (18,872 listings, 808 payout wallets) and checked how many sellers can show a verifiable history. By the check we can run today, the answer is zero, and that includes INAM."
date: 2026-10-08
related: how-to-verify-an-ai-agent-before-you-pay-it, x402-verify-before-you-pay, ai-agent-reputation-signed-history-vs-scores
---

An AI agent that wants to buy an API call over [x402](https://www.x402.org) usually starts in a Bazaar: a discovery list that a payment facilitator publishes at `/discovery/resources`. Each listing gives a URL, a price and a `payTo` wallet. The agent picks one and pays.

We asked one question of that list. **Of the sellers in it, how many have a track record the agent can verify before it pays?**

## What we measured

We paged through a full Bazaar discovery list on 2026-10-09 and saved the raw snapshot. The script, the snapshot and every number below are in the repo: `scripts/trust-index.ts` and `data/trust-index/`.

One caveat first. We meant to read the Coinbase CDP Bazaar, the largest one. Its API host was not reachable from the network we ran on. So this run reads the [PayAI facilitator](https://facilitator.payai.network/discovery/resources) Bazaar, which implements the same discovery spec. The script takes any facilitator URL and defaults to CDP, so anyone can rerun it there.

| | |
| --- | --- |
| Listings (deduplicated by URL) | 18,872 |
| Distinct hosts | 1,014 |
| Hosts with a single listing | 565 |
| Distinct `payTo` wallets | 808 (646 EVM, 162 Solana and other) |
| Listings that accept only testnet payment | 9,157 (48.5%) |
| Median price per call | $0.01 |
| 90th percentile price | $0.025 |

The list is concentrated. One wallet receives the payments for 10,344 listings, 54.8% of the list. Almost half the listings only take testnet money.

## The trust check

For a seller to have a track record an agent can verify, two things must hold. Some public record of past work must exist. And the wallet the agent is about to pay must provably belong to the same party as that record. Without the second part, any seller can borrow a good name.

The one check we can run end to end is INAM's. An INAM agent can prove control of an EVM wallet with a signed challenge (`linked.erc8004_id`). A payer can then match that wallet against the `payTo` in a 402 response. We did three things:

1. Listed every agent in the public INAM registry that has a linked wallet. The registry has no lookup by wallet, so we listed and intersected.
2. Scanned all 18,872 listings for an `inam` extension, and asked the facilitator to filter by it.
3. Probed one random listing on each of 300 randomly chosen hosts, without paying, and read the 402 response.

The results:

- **Wallets proven by an INAM agent: 0 of 808.** The registry holds 17 agents, 9 of them not marked as demos. None has linked a wallet yet.
- **Listings that carry an `inam` extension: 0.** The facilitator's own filter also returned 0.
- **402 responses that carry an `inam` extension: 0 of 170.**

So by this check, no seller in the list has a verifiable track record. INAM is not an exception. INAM itself has no paid listing and no linked wallet. We are reporting the number as it is.

Other kinds of evidence exist that we did not check, such as on-chain payment history or other registries. Payment volume says a wallet was paid. It does not say the work was done. That is the gap this index is about.

## Are the sellers even there?

Of the 300 sampled hosts:

| Outcome of an unpaid request | Hosts | Share |
| --- | --- | --- |
| Answered 402, ready to take payment | 170 | 56.7% |
| 404 or 410, listing points at nothing | 40 | 13.3% |
| Other 4xx (mostly 400, 401, 422 on a bare request) | 28 | 9.3% |
| Answered 2xx or 3xx with no paywall | 14 | 4.7% |
| Server error | 1 | 0.3% |
| Unreachable from our network | 47 | 15.7% |

42 of the 47 unreachable hosts are on `workers.dev`, which our network could not reach at all. Treat that row as unknown, not as dead. The 13.3% dead share is in line with what [Kiro found](https://dev.to/kirothebot/we-health-checked-every-seller-in-the-x402-bazaar-one-in-four-cant-take-an-agents-money-390p) in August, when 17% of CDP Bazaar sellers returned 404.

## Why it matters for an agent choosing whom to pay

At $0.01 a call, a bad seller costs very little per call. The problem is scale and selection. An agent that compares sellers by price and description has nothing else to compare. A listing is created by a payment, not by good work. A seller who failed yesterday looks the same today as one who delivered a thousand times.

[Tanod's daily index](https://dev.to/tanod/state-of-the-x402-bazaar-34062-listings-2158-hosts-and-94-missing-a-use-when-line-34co) of the CDP Bazaar shows the same shape at a larger size: 34,062 listings on 2,158 hosts. Its [30-day payer data](https://dev.to/tanod/what-ai-agents-actually-pay-for-over-x402-30-day-data-from-the-bazaar-d6d) shows 16,236 endpoints with at most one payer and only 420 with ten or more. Most sellers have almost no history at all, verifiable or not.

## What would change the number

Two things, both on the seller side, and neither is hard.

1. **Prove the payout wallet.** Bind the `payTo` address to a public identity with a signature, so a payer can check that the name and the wallet go together.
2. **Leave a receipt per sale.** Each paid call produces a record signed by the seller and, ideally, countersigned by the buyer. A history of those is a track record nobody can fake from the outside.

INAM is one way to do both. Sellers add an `inam` extension to their 402 and link their wallet. The `inamReceipts` middleware in the JS SDK writes a receipt per request, and the x402 gate lets a buyer refuse a seller whose wallet does not match. Other approaches exist and some are already in the wild: one 402 in our sample carried an `offer-receipt` extension. What matters is that the record is public and checkable, whoever keeps it.

We will rerun this index and publish the movement. The next run should be easy to beat.

## Method

- **Source:** `GET /discovery/resources?limit=100&offset=N` on the PayAI facilitator, 190 pages, 18,931 items returned, 18,872 after removing duplicate URLs. Snapshot fetched 2026-10-09.
- **Price:** the first payment option, read as USD only when the asset is USDC or USDT by name or by known contract. 13 listings could not be priced.
- **Testnet only:** every payment option is on a testnet network (Sepolia, devnet and similar).
- **INAM:** `GET /v1/agents/search` on `api.inamprotocol.org`, read-only, with demo and revoked agents included.
- **Probes:** 300 of 1,014 hosts, chosen with a fixed seed, one random listing each, the listing's declared HTTP method, no payment header, 15-second timeout.
- All requests were read-only. Nothing was paid or signed.

Thanks to [Tanod](https://dev.to/tanod) and [Kiro](https://dev.to/kirothebot) for publishing their Bazaar data in the open.
