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

## `reference-verifier.ts`

Makes SPEC.md §12.8 concrete: **where verification compute runs.** INAM is not an agent runtime (§0), and that covers verification — a registry records the signed *result* of a check (§12), it never runs the check. This file is a "shape 1" (inline) verifier: it reads a finalized receipt (an unsigned GET), runs its own `deterministic` output-hash check *in its own process*, then signs a Verification over that verdict. Each step is commented with what the registry does and does not do — on `POST /verifications` it only validates the signature, the operator's verifier grant (§12.3 rule 4), and the `outputHash` match; it does not re-run the check.

Runs against a local dev server; stops after signing unless you give it an operator key to also submit (both paths documented in the file header):

```
npm run dev                              # terminal 1
npx tsx examples/reference-verifier.ts    # terminal 2
```

## `coding-agent-verification.ts`

The trust problem `reference-verifier.ts` makes generic, applied to the specific case driving most current INAM interest: an AI coding agent self-reporting "tests pass" on its own work. A receipt's own `verification.method: "test_suite_pass"` field (SPEC.md §4) is the worker's own signed claim about its own output -- nothing stops it from being wrong, and industry-wide trust in that exact claim is dropping even as usage rises. This file runs two full rounds: a coding agent ships a subtly-buggy `isPalindrome()` (passes the happy path, fails on mixed case and punctuation) and self-reports success anyway; the requester finalizes on faith, same as most agent-to-agent coding handoffs do today. Then an independent verifier -- not the requester, not the provider -- pulls the code out of the finalized receipt and actually runs a broader test suite against it *in its own process* (SPEC.md §12.8), catches the bug, and submits a signed `rejected` Verification. The second round ships a fix; the same independent check now passes and submits `verified`. The run ends by printing the coding agent's reputation: both receipts are `finalized` (2), but only the fixed one is independently attested (`attestedReceipts: 1`) -- the number that reflects whether the code actually worked, not just what the agent claimed.

Runs against a local dev server; submitting the verification (not just signing it) needs an operator grant, same as `reference-verifier.ts`:

```
npm run dev                                     # terminal 1
npx tsx scripts/generate-operator-keypair.ts    # once, writes operator-key.json
INAM_OPERATOR_DID=<printed did> npm run dev     # terminal 1, restart with this
INAM_OPERATOR_KEY=./operator-key.json \
  npx tsx examples/coding-agent-verification.ts # terminal 2
```

## `langchain-tools.py`

The Python-side counterpart to `mcp-tool-wrapper.ts` for a different, very widely-used integration point: [LangChain](https://python.langchain.com/)'s tool-calling. Wraps four `sdk-python` `InamClient` methods (`register_agent`, `search_agents`, `submit_work`, `get_reputation`) as LangChain tools using the `@tool` decorator from `langchain_core.tools`. Like `mcp-tool-wrapper.ts`, it does **not** depend on the real `langchain`/`langchain-core` package being installed -- it falls back to a tiny local stand-in decorator so the file stays importable on its own, and uses the real decorator automatically if `langchain-core` is present. All four wrapped functions were smoke-tested against a local `npm run dev` server to confirm the request/response wiring is correct.

## `crewai_tools.py`

INAM's read tools for [CrewAI](https://docs.crewai.com/) agents: `inam_check_reputation`, `inam_search_agents` and `inam_get_receipt` (the receipt plus its verifications), wrapped with `@tool` from `crewai.tools` over `sdk-python`'s `InamClient`. Read-only, so they point at the live registry by default (`INAM_BASE_URL` to change it). The descriptions carry the same guidance as the MCP server's tools: check `evidenceLevel` before `trustScore`, since countersigned work means only the two parties vouched for it. Like `langchain-tools.py`, it falls back to a stand-in decorator without `crewai` installed. `python examples/crewai_tools.py` calls all three once against the live registry. Hand `INAM_TOOLS` to a CrewAI `Agent(tools=...)`.

## `x402-verify-before-pay.ts`

SPEC.md §11.2 end to end, no real money: a seller links its payment wallet to its INAM ID and finishes one job, then three x402 v2 endpoints ask the buyer to pay. The buyer's `fetch` is wrapped with `withInamX402Gate`, so it pays the honest seller, refuses an endpoint that names the seller's ID but routes the money to another wallet, and refuses a newcomer with no countersigned work. Swap the stand-in `fakePay` for `@x402/fetch`'s `wrapFetchWithPayment` in real use; the gate goes inside it. Local registry only (`npm run dev`), since it writes receipts.

![x402 verify-before-pay demo](https://inamprotocol.org/demo/x402-verify-before-pay.svg)

## `a2a-agent-card.ts`

SPEC.md §11.3 end to end: an agent links its A2A endpoint to its INAM ID, finishes one job, and serves an A2A 1.0 Agent Card carrying the `https://inamprotocol.org/ext/a2a/v1` extension. A second card copies the same INAM ID onto a different endpoint. The client fetches both cards and runs `verifyA2ACard`: it delegates to the first and skips the copycat, because the ID never linked that endpoint. Local registry only (`npm run dev`).

## `erc8004-feedback.ts`

SPEC.md §11.1 end to end, no chain writes: a requester and a provider each link an EVM address, finish one job, and the requester builds ERC-8004 `giveFeedback` arguments and the feedback file from the countersigned receipt. A reader then checks it with `verifyErc8004Feedback`: valid from the requester's wallet, rejected when the same file is replayed from another wallet. Send the printed arguments from any wallet in real use. Local registry only (`npm run dev`).
