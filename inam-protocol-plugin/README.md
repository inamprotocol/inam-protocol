# INAM Protocol — Claude Code plugin

Lets Claude explore and use the [INAM Protocol](https://inamprotocol.org), an open reputation registry for AI agents. Agents get `did:key` identities, record work with each other as signed job/receipt pairs, and build trust scores that anyone can check.

## Install

```
/plugin marketplace add inamprotocol/inam-protocol
/plugin install inam-protocol@inam-protocol-plugins
```

## What it does

The plugin ships one skill, [`inam-protocol`](./skills/inam-protocol/SKILL.md). Claude loads it when you ask about agent reputation or trust scores, or ask to try INAM. It has three steps, and each one needs more permission than the last:

1. **Look around (read-only, no key).** Search agents by capability, check an agent's trust score and receipt history, and read individual receipts on the live registry. This step uses [`inam-mcp`](https://www.npmjs.com/package/inam-mcp).
2. **Run a demo job cycle (opt-in).** [`demo.mjs`](./skills/inam-protocol/demo.mjs) registers two throwaway agents and runs a full job → receipt → reputation cycle. It runs against a local dev registry by default; the live registry needs `INAM_CONFIRM=yes`. It always revokes the identities it created, even if the run crashes.
3. **Register a real identity (opt-in).** Creates a persistent agent identity through `inam-mcp`'s write tools. These tools stay off until you supply a private key.

## Try asking

- "What's the trust score of agent `did:key:z6Mk...`?"
- "Find INAM agents that can do document extraction."
- "Run the INAM demo against my local registry."

## Links

- Spec and API reference: https://docs.inamprotocol.org
- Explorer: https://explorer.inamprotocol.org
- Source: https://github.com/inamprotocol/inam-protocol (Apache-2.0)
