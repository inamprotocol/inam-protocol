---
title: "Run a private reputation registry for your team's agents"
description: "Your internal agents call each other all day. A private INAM registry turns each of those calls into a signed receipt, so you can see which agents actually deliver. One container, about five minutes."
date: 2026-10-08
---

Most teams that use agents now have more than one. A planner hands work to a coder. The coder asks a reviewer. A support agent calls a lookup agent. Each of these is an HTTP call, and most leave no record beyond a log line.

That is fine until you need to answer a simple question: which of these agents does good work? Logs tell you a call happened. They do not tell you that both sides agree on what was asked and what came back.

## A track record, not a log

INAM records work as **execution receipts**. The agent that did the work drafts a receipt with hashes of the request and the response. The agent that asked for it checks those hashes against what it actually sent and received, then countersigns. A receipt with both signatures is final, and it feeds a reputation score for each agent.

For internal agents this gives you:

- A history per agent: how many jobs, for whom, and how many were disputed.
- Proof that a given output came from a given agent, signed by both sides.
- A score you can check before routing work to an agent.

You don't have to send any of this to a public service. The registry is open source and runs as one container.

## Five-minute setup

Start the registry:

```
docker run -d --name inam -p 4021:4021 -v inam-data:/data ghcr.io/inamprotocol/registry:main
curl http://localhost:4021/v1/health
```

Point the SDK at it and register two agents:

```ts
import { InamClient, generateKeypair } from "inamprotocol";

const reviewer = new InamClient("http://localhost:4021", generateKeypair());
const coder = new InamClient("http://localhost:4021", generateKeypair());
await reviewer.registerAgent(["code-review"]);
await coder.registerAgent(["code-review"]);
```

Wrap the reviewer's handler and the coder's calls:

```ts
import { inamReceipts, inamFetch } from "inamprotocol";

const handler = inamReceipts(handleReview, { client: reviewer, capability: "code-review" });

const inam = inamFetch(coder);
await inam.fetch("http://reviewer.internal/review", { method: "POST", body: diff });
await inam.settle();
```

Every call through `inam.fetch` now leaves a receipt both agents signed. Add `visibility: "participants_only"` to `inamReceipts` if the content should be readable only by the two agents involved. It still counts toward their scores.

To look around, open the public explorer against your own registry: `https://explorer.inamprotocol.org/?api=http://localhost:4021/v1`.

## What it does not do yet

A private registry is a single node with one SQLite database. Back up its `/data` volume. It does not federate with the public registry, so your agents' records stay inside your network. If you later want an agent to have a public track record, register it on the public registry too.

The full guide, with backups, the operator identity and the explorer details, is [SELF-HOSTING.md on GitHub](https://github.com/inamprotocol/inam-protocol/blob/main/SELF-HOSTING.md).
