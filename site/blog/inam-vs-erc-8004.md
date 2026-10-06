---
title: "INAM vs ERC-8004: task-linked receipts vs open feedback"
description: "ERC-8004's Reputation Registry lets anyone post a score. INAM only counts work both parties signed. Where each fits, where they overlap, and how one INAM receipt becomes ERC-8004 feedback."
date: 2026-10-06
---

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) ("Trustless Agents") is the Ethereum standard for agent identity and reputation. INAM is an open protocol for agent reputation built from signed execution receipts. People who find one usually ask about the other, so here is the short answer: **they are complementary at the identity layer and opposite designs at the reputation layer**, and since INAM v0.38 the two compose.

## What ERC-8004 defines

ERC-8004 is a Draft EIP with three on-chain registries:

- **Identity Registry.** An ERC-721 contract. Each agent gets a `tokenId` and an `agentURI` pointing at its registration file. This gives on-chain discovery and transferability.
- **Reputation Registry.** `giveFeedback()` stores a score (`value` plus `valueDecimals`), two optional tags, and an optional `feedbackURI` with a `feedbackHash`. Any caller except the agent's own owner or operators can post it.
- **Validation Registry.** Validators (stake-secured re-execution, zkML, TEE oracles) record responses to validation requests.

Feedback needs no proof of a task or a payment. The EIP says so plainly: Sybil attacks "are possible", and the mitigation is to make signals public so that many parties can build their own reputation systems on top.

## What happened when it was measured

A 2026 empirical study of the deployed registries, ["Can Trustless Agents Be Trusted?"](https://arxiv.org/abs/2606.26028), found:

- 95.4% of Ethereum feedback, 100% on BSC and 98.7% on Base carried **no payment proof and no task linkage**.
- Coordinated Sybil behavior in 73.6% of Ethereum reviewers, 59.2% on BSC and 90.6% on Base. Faking a score cost about $0.0027 per feedback on Base.
- No confirmed mainnet deployments of the Validation Registry in the observation window.

Its conclusion: the Reputation Registry, as deployed, "cannot function as a reliable trust signal." That is not a flaw in the EIP's text. It is what an open feedback channel produces when nothing ties a score to work.

## How INAM differs

INAM has no free-standing score to give. Reputation is computed only from **execution receipts**:

| | ERC-8004 Reputation Registry | INAM |
|---|---|---|
| Unit of reputation | A score anyone may post | A receipt naming a job, a spec hash and an output hash |
| Who must sign | The reviewer | Both parties (draft, then countersign) |
| Tied to a task | Optional | Always |
| Sybil handling | Left to whoever aggregates | Counterparties weighted by their own trust; repeat pairs count sub-linearly; old history decays |
| Independent checks | Validation Registry, open to any validator | Verifications count only from verifiers the registry operator granted |
| Where it lives | On-chain | Registry with a public Merkle transparency log, timestamped with OpenTimestamps |
| Trust assumption | Permissionless | A registry operator exists (stated in the spec, not hidden) |

The last row is the honest trade. ERC-8004 is permissionless and chain-native. INAM gives that up to get reputation that is tied to a specific job both sides agreed happened.

## Where they fit together

**Identity: use ERC-8004.** INAM deliberately has no identity registry. An INAM ID can prove control of an EVM address through a signed link challenge (`linked.erc8004_id`), so one agent can hold an ERC-8004 identity for on-chain discovery and an INAM reputation for "did this job actually happen".

**Reputation: publish receipts as feedback.** Since [SPEC v0.38 §11.1](https://docs.inamprotocol.org/spec/), a finalized, public INAM receipt can be posted to ERC-8004's Reputation Registry:

1. The requester calls `giveFeedback` from its linked ERC-8004 address, on the provider's `agentId`.
2. `value` is 100, 50 or 0 for a `success`, `partial` or `failed` outcome. `tag1` is `inam-receipt`, `tag2` is the job's capability.
3. The feedback file carries the signed receipt and both signatures. `feedbackHash` is the keccak256 of its exact bytes.

A reader treats that feedback as INAM-backed only if the file matches the hash, both signatures verify, the value matches the outcome, and the on-chain sender equals the requester's linked address. That last check is what answers the study's Sybil finding: copying a genuine feedback file to another wallet fails it.

The SDKs ship both halves:

```ts
import { buildErc8004Feedback, verifyErc8004Feedback } from "inamprotocol";
```

```python
from inamprotocol import build_erc8004_feedback, verify_erc8004_feedback
```

Both produce byte-identical feedback files. [`examples/erc8004-feedback.ts`](https://github.com/inamprotocol/inam-protocol/blob/main/examples/erc8004-feedback.ts) runs the full flow against a local registry.

## Which one should you use?

- You need on-chain agent discovery or NFT-style transferable identity: **ERC-8004 Identity**.
- You want a reputation number that cannot be inflated by posting scores: **INAM receipts**.
- You already read ERC-8004 feedback: **filter on `tag1 = inam-receipt` and verify the file**. You get the on-chain index and task-linked evidence.

Start with the [quickstart](https://github.com/inamprotocol/inam-protocol/blob/main/QUICKSTART.md) or read [§11.1 of the spec](https://docs.inamprotocol.org/spec/).
