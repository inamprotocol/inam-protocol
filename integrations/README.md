# Platform packages

Each package connects the same hosted, read-only MCP server (`https://api.inamprotocol.org/mcp`) and ships the same skill text
(source: `openai-plugin/skills/inam-protocol/SKILL.md`). Versions mirror the Claude Code plugin's (`inam-protocol-plugin/.claude-plugin/plugin.json`);
`npm run check:versions` fails if a version or a skill copy drifts.

| Platform | Folder | Install | Submission | Status |
|---|---|---|---|---|
| Claude Code | [`../inam-protocol-plugin`](../inam-protocol-plugin) | `/plugin marketplace add inamprotocol/inam-protocol` then `/plugin install inam-protocol@inam-protocol-plugins` | — (repo marketplace) | Live |
| ChatGPT + Codex directory | [`openai-plugin`](./openai-plugin) | after approval: Plugins Directory in ChatGPT / Codex | https://platform.openai.com/plugins (ZIP: `git archive --format=zip -o inam-openai-plugin.zip origin/main:integrations/openai-plugin`). Checklist: [`chatgpt-submission.md`](./chatgpt-submission.md) | Ready; needs identity verification + domain token |
| Codex repo marketplace | [`../.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json) → `openai-plugin` | `codex plugin marketplace add inamprotocol/inam-protocol`, then install from the "INAM Protocol" source in the Plugins Directory | none (no review) | Live once merged |
| Gemini CLI | [`gemini-cli-extension`](./gemini-cli-extension) | `gemini extensions install https://github.com/inamprotocol/inam-gemini-extension` | automatic: public repo [inamprotocol/inam-gemini-extension](https://github.com/inamprotocol/inam-gemini-extension) (tag v1.1.1, topic `gemini-cli-extension`); the gallery at https://geminicli.com/extensions indexes it daily | Live |
| Cursor | [`cursor-plugin`](./cursor-plugin) (listed by [`../.cursor-plugin/marketplace.json`](../.cursor-plugin/marketplace.json)) | after listing: Cursor **Customize** / marketplace; local test: copy the folder to `~/.cursor/plugins/local/inam-protocol` | https://cursor.directory (community, recommended by Cursor staff) and https://cursor.com/marketplace/publish (official), both with the repo URL | Ready; needs submission |
| Perplexity | none (custom connector) | see [Perplexity](#perplexity) below | none (no directory) | Works today |
| Manus | none (custom MCP server) | see [Manus](#manus) below | none (no directory) | Works today |

Both connect the hosted MCP directly. It is read-only and keyless, so pick no authentication and add no headers.

## Perplexity

Paid plans. Account settings → **Connectors** → **+ Custom connector** → **Remote**. Server URL `https://api.inamprotocol.org/mcp`,
transport **Streamable HTTP**, authentication **None**. Tick the risk acknowledgement, **Add**, then click the card to enable it.
Steps: [Adding Custom Remote Connectors](https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors).

## Manus

Settings → the custom MCP servers section (under Integrations or Connectors, depending on your version) → add a server.
Name `INAM`, server URL `https://api.inamprotocol.org/mcp`; if asked for a transport choose Streamable HTTP, and leave
authentication/headers empty. Manus tests the connection and lists the six `inam_*` tools.
Steps: [manus.im/docs/integrations/custom-mcp](https://manus.im/docs/integrations/custom-mcp).
