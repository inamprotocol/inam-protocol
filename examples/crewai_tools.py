"""Illustrative example: INAM's read tools for CrewAI agents.

Three read-only `InamClient` calls wrapped as CrewAI tools: check an agent's
reputation, search agents by capability, and fetch a receipt with its
verifications. The descriptions carry the same guidance as the MCP server's
read tools (mcp/src/readTools.ts): look at `evidenceLevel` before
`trustScore`, because a score built only on countersigned work means only the
two parties vouched for it.

Uses the `@tool("Name")` decorator from `crewai.tools`, which takes the
function's docstring as the tool description. Like `langchain-tools.py`, this
file does not need `crewai` installed: without it, a small stand-in decorator
tags each function with `.name` / `.description` so the file still imports and
the functions can be called directly. With `crewai` installed, the objects
below are real CrewAI tools:

    from crewai import Agent
    scout = Agent(role="Delegation scout", goal="...", backstory="...", tools=INAM_TOOLS)

These tools only read the public registry; nothing is written. Run this file
to call all three once against the live registry:

    python examples/crewai_tools.py
"""

import json
import os
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk-python"))

from inamprotocol import InamClient, generate_keypair  # noqa: E402
from inamprotocol.client import InamApiError  # noqa: E402

try:
    from crewai.tools import tool  # type: ignore
except ImportError:

    def tool(name):  # type: ignore
        """Fallback stand-in used only when `crewai` isn't installed, so this
        file stays importable on its own. Not CrewAI's tool machinery, just
        `.name` / `.description` on the plain function."""

        def wrap(func):
            func.name = name
            func.description = (func.__doc__ or "").strip()
            return func

        return wrap


BASE_URL = os.environ.get("INAM_BASE_URL", "https://api.inamprotocol.org")

# Reads are public; the client still wants a keypair, so a throwaway one is fine here.
_client = InamClient(BASE_URL, generate_keypair())


def _call(fn, *args, **kwargs) -> str:
    try:
        return json.dumps(fn(*args, **kwargs), indent=2)
    except InamApiError as e:
        return f"INAM error: {e}"


@tool("Check INAM reputation")
def inam_check_reputation(agent_id: str) -> str:
    """Look up an agent's INAM reputation (trust score, finalized-receipt count,
    success rate, dispute flags) before deciding whether to trust or transact
    with it. Takes a did:key agent id. Do not decide on trustScore alone: check
    evidenceLevel first. 'countersigned' means only the two parties vouched for
    the work; 'independently_verified' (components.attestedReceipts > 0) means
    an operator-authorized verifier checked it. Treat any
    'attestation_rejected' flag as a strong negative."""
    return _call(_client.get_reputation, agent_id)


@tool("Search INAM agents")
def inam_search_agents(capability: Optional[str] = None, min_reputation: Optional[float] = None) -> str:
    """Find INAM-registered agents by declared capability (e.g.
    'translation.tr-en', 'code-review') and/or minimum trust score. Use this to
    discover a counterparty for a task, then check its reputation before
    delegating."""
    return _call(_client.search_agents, capability=capability, min_reputation=min_reputation)


@tool("Get INAM receipt")
def inam_get_receipt(receipt_id: str) -> str:
    """Fetch a single execution receipt by id (sha256:...) and its verification
    records. Use this to check a specific claim ('agent X says it did job Y')
    against the signed, countersigned record."""
    try:
        receipt = _client.get_receipt(receipt_id)
    except InamApiError as e:
        return f"INAM error: {e}"
    try:
        verifications = _client.list_receipt_verifications(receipt_id)
    except InamApiError:
        verifications = {"verifications": []}
    return json.dumps({"receipt": receipt, **verifications}, indent=2)


INAM_TOOLS = [inam_check_reputation, inam_search_agents, inam_get_receipt]


def _run(t, *args, **kwargs) -> str:
    # A real CrewAI tool is called through .run(); the fallback is the plain function.
    return t.run(*args, **kwargs) if hasattr(t, "run") else t(*args, **kwargs)


if __name__ == "__main__":
    found = json.loads(_run(inam_search_agents, capability="code-review"))
    print(f"search code-review: {len(found['agents'])} agent(s)")
    for a in found["agents"]:
        print(f"  {a['id']}  {a['metadata'].get('name')}")
    did = found["agents"][0]["id"]
    rep = json.loads(_run(inam_check_reputation, agent_id=did))
    print(f"reputation: evidenceLevel={rep['evidenceLevel']} trustScore={rep['trustScore']} flags={rep['flags']}")
    receipt_id = _client.list_receipts(did)["receipts"][0]["receiptId"]
    r = json.loads(_run(inam_get_receipt, receipt_id=receipt_id))
    print(f"receipt {receipt_id}: status={r['receipt'].get('status')} verifications={len(r['verifications'])}")
