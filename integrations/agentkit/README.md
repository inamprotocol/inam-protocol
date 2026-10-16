# @inamprotocol/agentkit

Check an x402 seller before your Coinbase AgentKit agent pays it. Free, open source, never pays anything.

Two pieces, use either:

- `inamActionProvider()` adds one read-only action, `inam_check`. The agent calls it with a URL, wallet address or INAM ID and gets `pass` / `caution` / `fail`, the payTo wallet, and each warning (no ERC-8004 identity, wallet not linked to an INAM ID, plain `http://`, young domain, listing that is not a real 402).
- `inamGuardedFetch(fetch)` wraps `fetch` so every request is checked first and a `fail` throws `InamBlockedError` before any payment is signed. It is the pre-payment hook discussed in [coinbase/agentkit#1548](https://github.com/coinbase/agentkit/issues/1548).

```ts
import { AgentKit } from "@coinbase/agentkit";
import { inamActionProvider, inamGuardedFetch } from "@inamprotocol/agentkit";

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [inamActionProvider() /* , x402ActionProvider(), ... */],
});

// Or put the guard under your own x402 payment wrapper:
const pay = wrapFetchWithPayment(inamGuardedFetch(fetch, { block: ["fail"] }), client);
```

Guard options: `block` (verdicts that stop the request, default `["fail"]`, add `"caution"` to be strict), `onError` (`"block"` by default: if the check itself cannot run, the request stops; `"allow"` lets it through), `cacheMs` (default 5 minutes per URL and method).

## What the verdict does and does not mean

- `fail`: a key check failed (for example not an x402 paywall, or a certificate problem). Do not pay.
- `caution`: nothing failed, but identity signals are missing. This is where most sellers are today: in the [13 Oct scan](https://github.com/inamprotocol/inam-protocol/blob/main/data/x402-scan/x402-scan-2026-10-13.md) 92.6% of EVM payTo wallets had no ERC-8004 identity and no INAM link.
- `pass`: the public checks found no problem. It is not a guarantee about the seller's future behaviour, and a Solana-only payTo passes because EVM identity checks do not apply to it.
- An unreachable checker is reported as `unknown` by the action and blocks in the guard unless you set `onError: "allow"`. It is never read as a pass.

## Privacy and trust

Only the target (URL, address or ID) is sent to `https://api.inamprotocol.org/v1/check`. No payment data, keys or wallet state. Point `baseUrl` at your own registry to keep it in-house. INAM's registry is run by its maintainers, so the check reads public signals and says where each came from; it is not a trustless oracle ([SPEC §0](../../SPEC.md)).

## Develop

```sh
npm install && npm test        # vitest, mocked fetch, no network
```

The action uses AgentKit's `customActionProvider`, so no decorator or `reflect-metadata` setup is needed. Peer dependency `@coinbase/agentkit` `>=0.10.0`. If AgentKit wants this inside its monorepo instead, the code moves as is under `typescript/agentkit/src/action-providers/inam/`.

Apache-2.0. Not affiliated with Coinbase.
