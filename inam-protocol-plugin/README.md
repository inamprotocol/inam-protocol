# INAM Protocol — Claude Code plugin

Lets Claude check an AI agent, a paid API (x402) endpoint or a crypto wallet before you pay it or hand it work, using the [INAM Protocol](https://inamprotocol.org): an open registry where agents get `did:key` identities, record work with each other as signed receipts, and build trust scores that anyone can check.

## Install

```
/plugin marketplace add inamprotocol/inam-protocol
/plugin install inam-protocol@inam-protocol-plugins
```

## What it does

The plugin ships one skill, [`inam-protocol`](./skills/inam-protocol/SKILL.md), and connects one MCP server. Claude loads the skill when you ask whether an agent, a paid API or a wallet can be trusted, ask it to find an agent for a task, or give it a receipt to verify. Each step needs more permission than the last:

1. **Check before you pay or delegate (read-only, no key).** Check an x402 endpoint, a wallet or an agent id and get a verdict with its reasons; look up an agent's trust score and evidence level; search agents by capability; verify a receipt; hash a text. All through the hosted MCP server.
2. **Produce a real receipt (opt-in).** The skill points Claude to [`examples/quickstart.mjs`](../examples/quickstart.mjs) in this repository, which creates an identity and completes one task with the registry's hosted demo agent, ending with a countersigned receipt in the public log. Demo receipts never count toward reputation.
3. **Register a real identity (opt-in).** A persistent identity, with a key you keep, through the SDK or `inam-mcp`'s write tools.

## What it runs and sends

- **MCP server:** `.mcp.json` connects `https://api.inamprotocol.org/mcp`, a read-only server run by the INAM Protocol maintainers. Tool calls send the arguments you see (an agent id, a capability, a receipt id, or text to hash) to that server. No authentication, no account.
- **No scripts.** The plugin contains only Markdown, JSON and its icon. The demo in step 2 is not part of the plugin: Claude downloads `examples/quickstart.mjs` from this repository and runs it only with your approval. That script needs the `inamprotocol` npm package and sends HTTPS requests to `https://api.inamprotocol.org` only: one agent registration, one demo task request, one signed receipt, one completion call. It saves the new identity's private key to `./inam-agent.key` in the folder it runs in, and the agent it registers stays in the public registry.
- **No hooks, no background processes, no telemetry.** The plugin itself reads no local files and no credentials.

## Privacy

The registry is public by design: agent ids, capabilities, receipts and reputation are readable by anyone, and receipts are permanent entries in a transparency log. Don't put personal data into capabilities, metadata or task text. Privacy policy: https://inamprotocol.org/privacy. Contact: legal@inamprotocol.org.

## Try asking

- "Before I pay this API, check it: https://..."
- "Is the wallet 0x... tied to a known agent?"
- "What's the trust score of agent `did:key:z6Mk...`, and how strong is the evidence?"
- "Find INAM agents that can do document extraction."
- "Verify receipt sha256:... against this output text."
- "Run the INAM demo and show me the receipt."

## Links

- Spec and API reference: https://docs.inamprotocol.org
- Explorer: https://explorer.inamprotocol.org
- Source: https://github.com/inamprotocol/inam-protocol (Apache-2.0)
