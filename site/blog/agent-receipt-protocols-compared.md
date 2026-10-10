---
title: "Receipts for AI agents: INAM, Open Receipt, EMILIA, Agent Receipts and ERC-8004 compared"
description: "Several open projects now sign receipts for what AI agents do. They answer different questions: was it authorized, was it paid, what did the agent remember, did the work happen. A side-by-side guide."
date: 2026-10-06
related: inam-vs-erc-8004, ai-agent-reputation-signed-history-vs-scores, know-your-agent-needs-a-track-record
---

"Signed receipts for AI agents" now describes at least five open projects. They all use signatures and hashes, and they are easy to confuse. They answer different questions, though, and most of them can be used together. This guide compares them as of October 2026, from each project's own documentation.

## The short version

| Project | Question it answers | Who signs | Reputation score | Where records live | License |
|---|---|---|---|---|---|
| [INAM](https://github.com/inamprotocol/inam-protocol) | Did this job actually happen, and what is this agent's track record? | Both parties (requester and provider) | Yes, from receipts only | Registry + public Merkle transparency log | Apache-2.0 |
| [Open Receipt](https://github.com/Receiptprotocol/open-receipt) | What was authorized, delivered, charged, settled, refunded? | The issuer | No | Wherever the receipt travels; optional append-only issuance log | MIT |
| [EMILIA](https://github.com/emiliaprotocol/emilia-protocol) | Was this exact high-risk action authorized before it ran? | The mandate owner / authorized issuers | No | Offline-verifiable evidence; no transparency service yet | Apache-2.0 |
| [Agent Receipts](https://github.com/webaesbyamin/agent-receipts) | What did my agent do and learn? | The local agent | No (has an AI-judge tool) | Local SQLite | MIT |
| [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) | Who is this agent on-chain, and what do others say about it? | The reviewer | Raw feedback scores | Ethereum and L2s | EIP (CC0) |

## Open Receipt: commerce records

Open Receipt gives agents and automated commerce "portable, cryptographically verifiable proof of what was authorized, delivered, charged, settled, and refunded across platforms." An issuer signs the receipt. Verifiers can trust the issuer's key in three ways: embedded, a pinned metadata snapshot, or HTTPS resolution against allowlisted origins. An optional issuance attestation binds receipt digests into an append-only sequence with signed checkpoints.

It is a strong fit for **a merchant proving a transaction to a buyer or an auditor**. It does not try to score anyone.

## EMILIA: authorization before action

EMILIA is about the moment *before* an irreversible action: a payment, a deploy, a deletion. A gate checks that a named authority approved that exact action, and the resulting evidence can be verified offline under the verifier's own trusted keys. It uses Ed25519, with optional ML-DSA-65 hybrid signatures, and has individual IETF Internet-Drafts (not yet adopted by a working group).

It is a strong fit for **guardrails on what an agent is allowed to do**. It records authority, not track record.

## Agent Receipts: local memory with proof

Agent Receipts signs every action and memory an agent produces with Ed25519, stores them in a local SQLite database, and exposes them through an MCP server. "No API key. No account. No cloud." Bundles can be exported and verified elsewhere.

It is a strong fit for **auditing your own agent**. Because every receipt is signed by the agent itself, it is a record of the agent's own account, which is exactly right for a log and not meant as evidence to a stranger.

## ERC-8004: on-chain identity and open feedback

ERC-8004 adds three Ethereum registries: identity (ERC-721), reputation (`giveFeedback` scores) and validation. Feedback needs no task or payment proof, and a [2026 study](https://arxiv.org/abs/2606.26028) found 95–100% of deployed feedback carried neither, with coordinated Sybil behavior among 59–91% of reviewers. We cover it in detail in [INAM vs ERC-8004](/blog/inam-vs-erc-8004).

It is a strong fit for **on-chain discovery and identity**.

## INAM: reputation from work both sides signed

INAM answers the question the others leave open: *should I trust an agent I have never worked with?* Its unit is an execution receipt that names a job, a spec hash and an output hash, and it only counts once **both** parties have signed it. Reputation is computed from those receipts alone. Counterparties are weighted by their own trust, repeat pairs count sub-linearly, and old history decays, so a ring of throwaway identities vouching for each other barely moves a score. Independent verifications count only from verifiers the registry operator explicitly granted.

The trade-off is stated in the spec: INAM has a registry operator. It publishes every entry in a Merkle transparency log that anyone can audit, but it is not trustless.

It is a strong fit for **deciding whether to hire or pay an agent**. The SDK's `checkTrust` returns allow, escrow or deny with reasons, and an x402 gate refuses to sign a payment to an agent without a track record.

## They compose

These are layers, not rivals:

1. **EMILIA** decides the action may happen.
2. **x402 / Open Receipt** settle and record the payment.
3. **INAM** records that the work happened, signed by both sides, and updates reputation.
4. **ERC-8004** carries the result on-chain: an INAM receipt can be published as ERC-8004 feedback whose sender is checked against the requester's linked address ([spec §11.1](https://docs.inamprotocol.org/spec/)).
5. **Agent Receipts** keeps each agent's private log of what it did along the way.

If you only need one: pick by the question you are answering, not by the word "receipt".

Try INAM in a few minutes with the [quickstart](https://github.com/inamprotocol/inam-protocol/blob/main/QUICKSTART.md), or see the runnable [use cases](/use-cases).

*Corrections from any of these projects are welcome: [open an issue](https://github.com/inamprotocol/inam-protocol/issues).*
