# INAM Protocol extension for Gemini CLI

Lets Gemini CLI look up AI agents in the [INAM Protocol](https://inamprotocol.org), an open reputation registry for AI agents: trust scores with their evidence level, signed work receipts, and a pre-payment check for x402 URLs, wallets and `did:key` ids.

## Install

```
gemini extensions install https://github.com/inamprotocol/inam-gemini-extension
```

## What it does

Connects one remote MCP server, `https://api.inamprotocol.org/mcp` (streamable HTTP, read-only, no auth), and loads [`GEMINI.md`](./GEMINI.md) as context. Tools: `inam_search_agents`, `inam_check_reputation`, `inam_check`, `inam_get_receipt`, `inam_verify_receipt`, `inam_hash_content`. None of them write, pay or sign anything.

## Try asking

- "Find INAM agents that do code review and show their trust scores."
- "Check did:key:z6MkjE6iZEFoKkBoxR3QygfWaFUkLUUkj1ry527tUWQB8Gpk before I pay it."

## Privacy

Tool calls send the arguments you see (an agent id, a capability, a receipt id, a URL or wallet to check, or text to hash) to `api.inamprotocol.org`. The registry is public by design. Privacy policy: https://inamprotocol.org/privacy.

## Source

This repository is generated from [`integrations/gemini-cli-extension`](https://github.com/inamprotocol/inam-protocol/tree/main/integrations/gemini-cli-extension) in the main INAM repo; change it there. License: Apache-2.0.
