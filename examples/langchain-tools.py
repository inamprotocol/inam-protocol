"""Illustrative example: wrapping InamClient calls as LangChain tools.

SPEC.md's MCP section (§11) is already covered by
`examples/mcp-tool-wrapper.ts`. LangChain is a different, very widely-used
integration point -- Python-first, which pairs naturally with `sdk-python`
rather than `sdk-js`.

Like `mcp-tool-wrapper.ts`, this file does NOT depend on the real
`langchain` (or `langchain-core`) package being installed, and it is not
added as a project dependency anywhere in this repo. It shows the *shape*
of the integration -- four `InamClient` methods wrapped as LangChain
`Tool` objects -- so you can copy the pattern into an agent that already
uses LangChain's tool-calling. The point, same as the MCP file: you don't
rewrite your agent for INAM, you add a few tool calls to what it already
has.

Tool-definition style used here: the `@tool` decorator from
`langchain_core.tools`, which infers a structured args schema from the
wrapped function's type hints and uses its docstring as the tool
description. This is the simplest, most stable pattern across recent
LangChain versions (the package split into `langchain-core` /
`langchain-community` / provider packages a while back, and `@tool` in
`langchain_core.tools` has been the recommended home for defining a single
tool since that split) -- preferred here over anything tied to a specific
agent-executor class or a fast-moving convenience wrapper. That said: exact
decorator kwargs (e.g. `response_format`, async variants) do shift between
minor versions, so if you're pinning a real dependency, check the
LangChain docs current at the time rather than trusting this comment
as gospel.

Because this file must still be importable/readable without `langchain`
installed, the import below falls back to a tiny local stand-in decorator
that just tags a function with `.name`/`.description` -- enough to keep
this file self-contained, not a reimplementation of LangChain's tool
machinery. If `langchain-core` *is* installed, the real decorator is used
and the objects below are genuine `StructuredTool`s ready to hand to any
LangChain agent executor (`tools=INAM_TOOLS`, `bind_tools(INAM_TOOLS)`,
etc.).
"""

import json
import sys
from pathlib import Path
from typing import List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk-python"))

from inamprotocol import InamClient, generate_keypair  # noqa: E402

try:
    from langchain_core.tools import tool  # type: ignore
except ImportError:

    def tool(func):  # type: ignore
        """Fallback stand-in used only when `langchain-core` isn't
        installed, so this file stays importable on its own. Not a
        reimplementation of LangChain's actual tool machinery -- just
        enough (`.name` / `.description`) to keep the functions below
        inspectable the same way a real `Tool` object would be."""
        func.name = func.__name__
        func.description = (func.__doc__ or "").strip()
        return func


BASE_URL = "http://localhost:4021"

# In a real agent this keypair would be loaded from wherever the agent
# already keeps its long-lived secrets, not generated per process (same
# caveat as examples/mcp-tool-wrapper.ts).
_keypair = generate_keypair()
_client = InamClient(BASE_URL, _keypair)


@tool
def inam_register_agent(capabilities: List[str], name: Optional[str] = None) -> str:
    """Register this agent's identity with the INAM registry so other
    agents can find it by capability and check its reputation before
    delegating work to it. `capabilities` are dotted strings like
    ['document-extraction'] or ['translation.tr-en']."""
    metadata = {"name": name} if name else None
    return json.dumps(_client.register_agent(capabilities, metadata))


@tool
def inam_search_agents(capability: str, min_reputation: Optional[float] = None) -> str:
    """Search the registry for agents offering a given capability, optionally
    filtered by a minimum reputation score. Use this before delegating a
    subtask to another agent -- it's how an orchestrator picks a
    counterparty it doesn't already know, rather than hardcoding one."""
    return json.dumps(_client.search_agents(capability=capability, min_reputation=min_reputation))


@tool
def inam_submit_work(
    requester_id: str,
    job_id: str,
    capability: str,
    spec_hash: str,
    output_hash: str,
) -> str:
    """Submit a signed draft Execution Receipt for completed work. Called by
    the agent that did the work (agent_b), naming the requesting agent's
    did:key (agent_a) as `requester_id`. The requester still has to
    countersign (a separate step, not exposed as a tool here) before this
    counts toward reputation -- one party's draft alone is only a claim."""
    now = _now_iso()
    return json.dumps(
        _client.submit_work(
            requester_id,
            {
                "jobId": job_id,
                "task": {"capability": capability, "specHash": spec_hash, "createdAt": now},
                "result": {"outputHash": output_hash, "completedAt": now},
                "verification": {"method": "payer_confirmation", "outcome": "success"},
            },
        )
    )


@tool
def inam_get_reputation(agent_id: str) -> str:
    """Look up an agent's current reputation score and its components
    (trust score, verified/attested receipt counts, success rate) before
    deciding whether to work with it. `agent_id` is the agent's did:key."""
    return json.dumps(_client.get_reputation(agent_id))


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


# Ready to pass straight to a LangChain agent executor, e.g.:
#   from langchain.agents import create_react_agent  # or your framework's equivalent
#   agent = create_react_agent(llm, INAM_TOOLS, prompt)
INAM_TOOLS = [inam_register_agent, inam_search_agents, inam_submit_work, inam_get_reputation]
