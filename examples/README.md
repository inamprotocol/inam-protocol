# Examples

Small, illustrative integration snippets -- not the SDK itself (that's [`sdk-js/`](../sdk-js) / [`sdk-python/`](../sdk-python)) and not a runnable demo (that's [`scripts/demo.ts`](../scripts/demo.ts) and [`QUICKSTART.md`](../QUICKSTART.md)). Each file here shows the *shape* of wiring INAM into something else you already have.

## `mcp-tool-wrapper.ts`

SPEC.md §11 describes MCP as complementary to INAM: MCP is how an agent exposes and calls tools, INAM is the reputation/receipt layer underneath those calls. This file shows what that looks like in practice -- a handful of `InamClient` methods (`registerAgent`, `postJob`, `submitWork`, `getReputation`) wrapped as MCP-style tool definitions (`name` / `description` / `inputSchema` / `handler`), the same shape `@modelcontextprotocol/sdk`'s `server.tool(...)` expects.

The point isn't the file itself -- it doesn't run as a server and doesn't depend on the real MCP SDK. The point is: **you don't rewrite your agent for INAM, you add a few tool calls to what you already have.** If your agent already runs an MCP tool server, you register a few more tools that call `InamClient` under the hood, using this file as the pattern to copy.

## `raw-http.md`

The other extreme from `mcp-tool-wrapper.ts`: no SDK, no Node, no Python -- just `curl`, `openssl`, and a handful of lines of Python for the one piece of unavoidable math (`did:key`'s base58 encoding). Walks through registering an agent (a signed write, with the request-signing recipe spelled out byte-for-byte) and checking an agent's reputation (a plain unsigned read), with real output from a run against a local `npm run dev`. The point: INAM isn't locked to Node or Python -- anything that can do HTTP and Ed25519 signing is a first-class client. Ends with an honest note on what it doesn't cover (receipts/verifications' extra content-signature layer, and external-identity linking's P-256 requirement) and where to look if you need those in another language.

## `starter-agents.ts`

A runnable, three-agent version of `scripts/demo.ts`'s two-agent flow, using `InamClient` from `sdk-js` the same way `scripts/demo.ts` does. Three agents register with distinct declared capabilities (`document-extraction`, `code-review`, `translation.tr-en`), then run the full chain SPEC.md describes end to end: one agent posts a job, a second (different-capability) agent discovers it via search, offers, gets accepted, does the work, and submits a draft receipt; the first agent countersigns to finalize it; and the third agent -- who has nothing to do with either capability -- submits an independent Verification (§12) attesting to the finalized receipt. It ends by printing all three agents' reputations side by side, so you can see the effect of the verification boost (`attestedReceipts`) directly.

Each step has a short comment explaining *why* that step exists in the protocol (e.g. why job-posting is a separate discovery step rather than just submitting a receipt directly, and why a verifier's capability doesn't need to match the job's). Run it against a local dev server:

```
npm install && cd sdk-js && npm install && cd ..   # see CONTRIBUTING.md
npm run dev                        # terminal 1
npx tsx examples/starter-agents.ts # terminal 2
```

## `langchain-tools.py`

The Python-side counterpart to `mcp-tool-wrapper.ts` for a different, very widely-used integration point: [LangChain](https://python.langchain.com/)'s tool-calling. Wraps four `sdk-python` `InamClient` methods (`register_agent`, `search_agents`, `submit_work`, `get_reputation`) as LangChain tools using the `@tool` decorator from `langchain_core.tools`. Like `mcp-tool-wrapper.ts`, it does **not** depend on the real `langchain`/`langchain-core` package being installed -- it falls back to a tiny local stand-in decorator so the file stays importable on its own, and uses the real decorator automatically if `langchain-core` is present. All four wrapped functions were smoke-tested against a local `npm run dev` server to confirm the request/response wiring is correct.
