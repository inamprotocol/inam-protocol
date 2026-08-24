# Examples

Small, illustrative integration snippets -- not the SDK itself (that's [`sdk-js/`](../sdk-js) / [`sdk-python/`](../sdk-python)) and not a runnable demo (that's [`scripts/demo.ts`](../scripts/demo.ts) and [`QUICKSTART.md`](../QUICKSTART.md)). Each file here shows the *shape* of wiring INAM into something else you already have.

## `mcp-tool-wrapper.ts`

SPEC.md §11 describes MCP as complementary to INAM: MCP is how an agent exposes and calls tools, INAM is the reputation/receipt layer underneath those calls. This file shows what that looks like in practice -- a handful of `InamClient` methods (`registerAgent`, `postJob`, `submitWork`, `getReputation`) wrapped as MCP-style tool definitions (`name` / `description` / `inputSchema` / `handler`), the same shape `@modelcontextprotocol/sdk`'s `server.tool(...)` expects.

The point isn't the file itself -- it doesn't run as a server and doesn't depend on the real MCP SDK. The point is: **you don't rewrite your agent for INAM, you add a few tool calls to what you already have.** If your agent already runs an MCP tool server, you register a few more tools that call `InamClient` under the hood, using this file as the pattern to copy.
