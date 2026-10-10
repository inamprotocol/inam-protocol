---
title: "Know Your Agent tells you who. Receipts tell you whether it delivered."
description: "Visa, Mastercard and Ant International are aligning on Know Your Agent (KYA). Identity and certification answer who an agent is. They don't record whether its past work was any good. Here is the missing record, and how it plugs in."
date: 2026-10-08
related: ai-agent-reputation-signed-history-vs-scores, how-to-verify-an-ai-agent-before-you-pay-it, agent-receipt-protocols-compared
---

On 10 September 2026, Ant International, Mastercard and Visa announced that they will align their agent-verification systems under a shared **Know Your Agent (KYA)** framework. It brings together Visa's Trusted Agent Protocol, Mastercard's Verifiable Intent and Agent Pay, and Ant's Agentic Mobile Protocol. It is a framework under development, not a deployed standard, and it rests on three principles:

1. **Operator traceability**: link each AI agent to a validated operator.
2. **Shared certification**: assess agents against agreed security and behavioral conditions.
3. **Continuous transaction monitoring**: combine identity and payment signals for ongoing assessment.

Three weeks later Mastercard added a "trust and intelligence" layer to Agent Pay, with Skyfire handling KYA identity and Cloudflare contributing web signals. The payment networks now agree that an agent has to be known before it can be trusted with money.

This is the right starting point, and it leaves a gap that is worth stating precisely.

## What KYA answers, and what it doesn't

The first two principles answer **who**: which operator stands behind this agent, and whether that operator's agent met a certification bar. KYC does the same for people: a verified identity and a passed check.

KYC alone never told a lender whether a borrower repays. That took a credit history: a record of past obligations and how each one ended. Agents need the equivalent, and the third principle only partly covers it:

- **Payment signals show that money moved, not that the work was done.** A charge that settles looks the same whether the agent delivered a correct translation or a page of garbage. Disputes surface some failures, late and only for the ones somebody contests.
- **The monitoring lives inside each network.** Under the framework, each network keeps its own verification and decision process. An agent's history with one network is not something a merchant on another network, or another agent, can read and check.
- **Agent-to-agent work often has no card payment at all.** A coding agent delegating a review to another agent, or an x402 micropayment in stablecoins, never touches a card network.

So the open question is not who the agent is. It is **what this agent has done, for whom, and how that work turned out**, in a form that anyone can check and that travels with the agent.

## The missing record: work both parties signed

[INAM Protocol](https://github.com/inamprotocol/inam-protocol) is an open registry built for that record. When a job finishes, the agent that did the work drafts an **execution receipt**: the task's hash, the output's hash, timestamps, the outcome, and an optional settlement reference. It signs the receipt, and the requester countersigns it. Some receipts are later re-checked by independent verifiers. Every finalized receipt is appended to a public Merkle **transparency log**, so it can't be silently edited or removed.

Reputation is computed only from those receipts, and every answer says how strong its evidence is:

- `none`: no counted work yet.
- `countersigned`: the two parties agree the work happened. This is their word, not proof of quality.
- `independently_verified`: a verifier authorized by the registry operator re-checked the work.

Applied to the KYA principles:

- **Traceability.** An INAM identity is a `did:key`. It can prove control of an EVM wallet (ERC-8004), claim an A2A endpoint, and be named on an A2A Agent Card, so the identity layer you already use points at the same track record.
- **Monitoring.** Receipts are task-level evidence, not payment-level. A network, merchant or agent can read an agent's receipts and its evidence level before it transacts, and can recompute everything from the signed records instead of trusting the registry's own score.
- **Portability.** The registry is public and the format is open (Apache-2.0). No account or API key is needed to read it, over REST, A2A or MCP.

## Fake history is the first attack, so we tested for it

A track record is only useful if it is expensive to fake. Early in October an AI agent run by an outside researcher [showed](https://github.com/inamprotocol/inam-protocol/issues/26) that 12 fresh identities countersigning each other could reach a trust score of 60 out of 100. Since SPEC v0.39, a counterparty with no stake and no history outside the agent's own circle lends zero weight, and that ring scores 0. What is still open is written down in the [threat model](https://github.com/inamprotocol/inam-protocol/blob/main/THREAT-MODEL.md): a ring whose members each obtain one real outside receipt can still raise its scores until a seeded, multi-hop trust computation lands.

INAM is not KYC for operators, not a payment network and not a certification body. It is the history layer that those checks don't provide.

## Where it plugs in today

- **Before paying over x402:** the payer checks that the payee's INAM identity proved control of the `payTo` wallet and has countersigned work, and pays only then. The gate records exactly what it checked as a hashed policy input, and an outside implementer has [recomputed those vectors independently](https://github.com/x402-foundation/x402/issues/1777).
- **Before delegating over A2A or MCP:** call the hosted read-only MCP server at `https://api.inamprotocol.org/mcp`, or `checkTrust()` in the SDK, to get an allow, escrow or deny decision under your own thresholds.
- **As one input to monitoring:** a network or platform can read receipts like any other signal. They are public and signed, so it doesn't have to trust us to use them.

## Try it in a minute

Give an agent an identity and its first countersigned, logged receipt. The registry's demo agent acts as the other party, and demo receipts never count toward reputation:

```
npm i inamprotocol
curl -sO https://raw.githubusercontent.com/inamprotocol/inam-protocol/main/examples/quickstart.mjs && node quickstart.mjs
```

If you work on KYA, agent payments or agent identity and want to discuss how task-level evidence should feed into continuous monitoring, open a [discussion](https://github.com/inamprotocol/inam-protocol/discussions). Attacks on the scoring are even more welcome.

---

Sources: [TNGlobal on the KYA framework](https://technode.global/2026/09/10/ant-international-mastercard-visa-develop-kya-framework/) · [PYMNTS](https://www.pymnts.com/cybersecurity/2026/visa-mastercard-team-with-ant-know-your-agent-framework) · [Mastercard Agent Pay trust and intelligence](https://fintechspecs.com/blog/mastercard-agent-pay-trust-intelligence-skyfire-kya-2026/) · [Cloudflare on agentic commerce with Visa and Mastercard](https://blog.cloudflare.com/secure-agentic-commerce/)
