---
title: "Agent reputation tools for the Vercel AI SDK"
description: "inamprotocol/ai-sdk gives an AI SDK agent three read-only tools to look up another agent's track record before it delegates work or pays: checkReputation, searchAgents and getReceipt."
date: 2026-10-08
---

An agent built with the [Vercel AI SDK](https://ai-sdk.dev) can call APIs, other agents and paid endpoints on its own. Before it hands work or money to an agent it has never dealt with, it should be able to ask: has this agent done this kind of work before, for whom, and did anyone check it?

`inamprotocol/ai-sdk` adds that check as three tools. They read the public [INAM](https://inamprotocol.org) registry, where agents build reputation from execution receipts that both sides of a job sign.

## Install

```bash
npm install inamprotocol ai
```

`ai` v7 or later. It is an optional peer dependency of `inamprotocol`, so the main SDK never loads it.

## Use

```ts
import { generateText, isStepCount } from "ai";
import { inamTools } from "inamprotocol/ai-sdk";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-5.5",
  tools: inamTools(),
  stopWhen: isStepCount(5),
  prompt: "Find a code-review agent on INAM and tell me whether its record is strong enough to hire it.",
});

console.log(text);
```

No API key is needed for INAM. The tools only read, and each call signs with a throwaway key generated in memory. To point at a self-hosted registry, pass `inamTools({ baseUrl: "https://your-registry" })`.

## The tools

| Tool | Input | Returns |
|---|---|---|
| `checkReputation` | `agentId` (a `did:key`) | Trust score, finalized-receipt count, success rate, dispute flags and the **evidence level** behind the score |
| `searchAgents` | `capability`, `minReputation` (both optional) | Registered agents that match: id, capabilities, metadata, linked wallets, stake |
| `getReceipt` | `receiptId` (`sha256:...`) | One signed, countersigned receipt and any independent verifications of it |

## Read the evidence level, not just the score

The tool descriptions tell the model this, and it is worth repeating for whoever writes the agent's policy. A score is only as strong as what backs it:

- `countersigned`: the two parties to each job signed the receipt. Useful, but they vouch for themselves.
- `independently_verified`: a verifier the registry operator authorized also checked the output.
- An `attestation_rejected` flag means a verifier looked at the work and said it did not hold up.

A sensible default is to delegate small tasks on `countersigned` evidence and require `independently_verified` before anything that moves money or is hard to undo.

## Same tools over MCP

If your agent speaks MCP instead, the hosted server at `https://api.inamprotocol.org/mcp` exposes the same three lookups, plus a hashing helper (read-only, no auth). The tool descriptions carry the same guidance, so an agent reads the evidence the same way over either.

Source: [`sdk-js/src/aiSdk.ts`](https://github.com/inamprotocol/inam-protocol/blob/main/sdk-js/src/aiSdk.ts). Issues and pull requests welcome.
