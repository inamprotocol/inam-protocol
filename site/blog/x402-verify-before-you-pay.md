---
title: "x402: verify an agent before you pay it"
description: "x402 lets an agent pay for an API call with one HTTP retry. It does not tell the payer whether the wallet on the other side belongs to anyone with a track record. A small gate that checks first, tested with real USDC on Base Sepolia."
date: 2026-10-06
related: how-to-verify-an-ai-agent-before-you-pay-it, agent-trust-index-2026-10, agent-receipt-protocols-compared
---

[x402](https://www.x402.org) turns HTTP 402 into a working payment flow: the server answers `402 Payment Required` with what it accepts, the client signs a payment and retries, and a facilitator settles it on-chain. For agents this is a big deal. An agent can buy a forecast, a dataset or a code review per call, with no account and no API key.

What x402 does not answer is **who you are paying**. The 402 response names a `payTo` wallet and a price. An agent with a payment wrapper will pay any server that asks, as long as the price fits. That is fine for a known API. It is a problem for an agent choosing between unknown sellers on its own.

## The missing check

Before signing, a careful payer wants to know three things:

1. Does this seller have an identity anyone can look up?
2. Is the wallet it wants paid actually *that* identity's wallet, and not someone borrowing a good name?
3. Has that identity done real, countersigned work before?

INAM answers all three from data that already exists: an agent's INAM ID, a wallet it has proven control of, and execution receipts signed by both sides of past jobs.

## How it works (SPEC v0.36 §11.2)

**The seller names its INAM ID** in the x402 v2 `PaymentRequired` object, as an `inam` extension:

```json
"extensions": { "inam": { "info": { "did": "did:key:z6Mk..." } } }
```

**The payer checks before it signs:**

1. The ID resolves in the registry and is not revoked.
2. **Binding.** Every `payTo` it might pay equals the EVM address the ID proved control of (`linked.erc8004_id`, verified through a signed link challenge). Entries that don't match are dropped; if none remain, nothing is paid. Without this step, a server could name a reputable agent's ID and route the money to its own wallet.
3. **Policy.** The ID's evidence level and trust score meet the payer's own thresholds.

The extension is advisory. A seller that omits it is simply unknown to INAM, and the payer's policy decides what to do with unknowns. The registry takes no part in the payment and never touches money.

## In code

Sellers add one line to their x402 route config:

```ts
import { inamX402Extension } from "inamprotocol";

app.use(paymentMiddleware({
  "GET /weather": {
    accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:84532", payTo }],
    extensions: inamX402Extension(myDid),
  },
}, server));
```

Buyers wrap `fetch` with the gate *inside* the x402 payment wrapper, so a blocked seller throws before anything is signed:

```ts
import { InamClient, generateKeypair, withInamX402Gate, X402PaymentBlocked } from "inamprotocol";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";

const inam = new InamClient("https://api.inamprotocol.org", generateKeypair()); // read-only use, any key
const gated = withInamX402Gate(fetch, inam, { minEvidence: "countersigned" });
const pay = wrapFetchWithPaymentFromConfig(gated, { schemes: [{ network, client }] });

try {
  const res = await pay("https://seller.example/weather");
} catch (e) {
  if (e instanceof X402PaymentBlocked) console.log("not paid:", e.decision.reason);
}
```

The policy takes `minEvidence` (default `countersigned`) and `minTrustScore` (default 0). For a broader allow / escrow / deny decision outside x402, the SDK also has `checkTrust`.

## What the demo shows

[`examples/x402-verify-before-pay.ts`](https://github.com/inamprotocol/inam-protocol/blob/main/examples/x402-verify-before-pay.ts) runs three paid endpoints against a local registry:

| Endpoint | Names INAM ID of | Pays to | Result |
|---|---|---|---|
| `/forecast` | An agent with a countersigned job | That agent's proven wallet | **Paid** |
| `/borrowed` | The same reputable agent | Someone else's wallet | **Blocked**: payTo is not the ID's wallet |
| `/newcomer` | A new agent with a proven wallet | Its own wallet | **Blocked**: no countersigned history yet |

The second row is the attack the binding check exists for. The third is policy: a payer that is happy to try newcomers can lower `minEvidence`.

## Tested with real payments

We also ran it against the real stack: `@x402/fetch` and `@x402/express` with the public x402.org facilitator on **Base Sepolia**, paying in test USDC. Three payments of 0.01 USDC settled on-chain to a seller whose INAM ID was bound to its `payTo`, with the gate in front of every one.

The run also found a bug. When a seller rejected a payment that had already been signed, the gate saw the second 402 and reported "blocked", which hid the real error from the payment wrapper. Since `inamprotocol` 0.17.1, the gate lets a 402 that answers a paid retry through untouched. That is the kind of thing a mock never shows.

## Limits, stated plainly

- Only EVM `payTo` addresses can be bound today, because `erc8004_id` is the only linked identity that is a payment address.
- The reputation is the registry's hint. A payer that wants certainty can re-derive it from the public receipts and transparency log.
- INAM has a registry operator. It publishes every entry in an auditable Merkle log, but it is not trustless.

## Try it

```bash
git clone https://github.com/inamprotocol/inam-protocol && cd inam-protocol && npm install
npm run dev                                   # terminal 1: local registry
npx tsx examples/x402-verify-before-pay.ts    # terminal 2
```

In your own project it is just `npm i inamprotocol`.

Read [§11.2 of the spec](https://docs.inamprotocol.org/spec/), the [quickstart](https://github.com/inamprotocol/inam-protocol/blob/main/QUICKSTART.md), or how INAM relates to other agent-receipt projects in [Receipts for AI agents, compared](/blog/agent-receipt-protocols-compared).
