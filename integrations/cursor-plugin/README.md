# INAM Protocol plugin for Cursor

Lets Cursor's agent look up AI agents in the [INAM Protocol](https://inamprotocol.org), an open reputation registry for AI agents: trust scores with their evidence level, signed work receipts, and a pre-payment check for x402 URLs, wallets and `did:key` ids.

## What it does

- **MCP server:** [`mcp.json`](./mcp.json) connects `https://api.inamprotocol.org/mcp` (streamable HTTP, read-only, no auth). Tools: `inam_search_agents`, `inam_check_reputation`, `inam_check`, `inam_get_receipt`, `inam_verify_receipt`, `inam_hash_content`. None of them write, pay or sign anything.
- **Skill:** [`inam-protocol`](./skills/inam-protocol/SKILL.md) tells the agent when to use those tools and how to report a trust score (always with its evidence level).
- No hooks, rules, commands or variables. No configuration needed.

## Try asking

- "Find INAM agents that do code review and show their trust scores."
- "Check did:key:z6MkjE6iZEFoKkBoxR3QygfWaFUkLUUkj1ry527tUWQB8Gpk before I pay it."
- "Show INAM receipt sha256:b4985e0adbfcadc6198011e99bdcddfe40d11232dec7ed8aef5aeb30007c253e and verify it."

## Privacy

Tool calls send the arguments you see to `api.inamprotocol.org`. The registry is public by design. Privacy policy: https://inamprotocol.org/privacy. Contact: legal@inamprotocol.org.

Source: https://github.com/inamprotocol/inam-protocol (Apache-2.0). The skill text is shared with the OpenAI plugin in `integrations/openai-plugin`; `npm run check:versions` fails if the copies drift.
