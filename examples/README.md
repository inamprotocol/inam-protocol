# Examples

Small, illustrative integration snippets -- not the SDK itself (that's [`sdk-js/`](../sdk-js) / [`sdk-python/`](../sdk-python)) and not a runnable demo (that's [`scripts/demo.ts`](../scripts/demo.ts) and [`QUICKSTART.md`](../QUICKSTART.md)). Each file here shows the *shape* of wiring INAM into something else you already have.

## `mcp-tool-wrapper.ts`

SPEC.md §11 describes MCP as complementary to INAM: MCP is how an agent exposes and calls tools, INAM is the reputation/receipt layer underneath those calls. This file shows what that looks like in practice -- a handful of `InamClient` methods (`registerAgent`, `postJob`, `submitWork`, `getReputation`) wrapped as MCP-style tool definitions (`name` / `description` / `inputSchema` / `handler`), the same shape `@modelcontextprotocol/sdk`'s `server.tool(...)` expects.

The point isn't the file itself -- it doesn't run as a server and doesn't depend on the real MCP SDK. The point is: **you don't rewrite your agent for INAM, you add a few tool calls to what you already have.** If your agent already runs an MCP tool server, you register a few more tools that call `InamClient` under the hood, using this file as the pattern to copy.

## `raw-http.md`

The other extreme from `mcp-tool-wrapper.ts`: no SDK, no Node, no Python -- just `curl`, `openssl`, and a handful of lines of Python for the one piece of unavoidable math (`did:key`'s base58 encoding). Walks through registering an agent (a signed write, with the request-signing recipe spelled out byte-for-byte) and checking an agent's reputation (a plain unsigned read), with real output from a run against a local `npm run dev`. The point: INAM isn't locked to Node or Python -- anything that can do HTTP and Ed25519 signing is a first-class client. Ends with an honest note on what it doesn't cover (receipts/verifications' extra content-signature layer, and external-identity linking's P-256 requirement) and where to look if you need those in another language.
