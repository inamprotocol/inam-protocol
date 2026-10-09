"""Illustrative example: a Google ADK agent that checks INAM before delegating over A2A.

SPEC.md §11.3: an A2A Agent Card may name its INAM ID in the data-only
extension `https://inamprotocol.org/ext/a2a/v1`. A client accepts that ID only
when one of the card's endpoints equals the ID's `linked.a2a_endpoint`, then
applies its reputation policy. `check_a2a_agent` below is a Python port of
`verifyA2ACard` / `decideA2A` from `sdk-js/src/a2a.ts`, with the same rules and
reason strings, exposed as an ADK function tool:

1. fetch the Agent Card and read the INAM ID from the extension;
2. fetch that agent and its reputation from INAM (the registry the client
   trusts; the card does not choose it);
3. deny if revoked, deny unless a card endpoint is the linked `a2a_endpoint`
   (ignoring a trailing slash), deny if the reputation misses the policy
   (`evidenceLevel` at least `min_evidence`, `trustScore` at least
   `min_trust_score`), else allow.

Like `langchain-tools.py`, this file does not need `google-adk` installed:
without it, a stand-in `Agent` just keeps its keyword arguments, so the file
imports and `check_a2a_agent` can be called directly. With `google-adk`
installed, `root_agent` is a real ADK agent (`adk run` / `adk web` pick it up
from a package that exposes it). Only reads the registry; nothing is written.

    python examples/adk_a2a_check.py https://agent.example/.well-known/agent-card.json
"""

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk-python"))

from inamprotocol import InamClient, generate_keypair  # noqa: E402
from inamprotocol.client import InamApiError  # noqa: E402
from inamprotocol.trust import policy_failure  # noqa: E402

try:
    from google.adk.agents import Agent  # type: ignore
except ImportError:

    class Agent:  # type: ignore
        """Fallback stand-in used only when `google-adk` isn't installed. Not
        ADK's agent, just its constructor arguments kept as attributes."""

        def __init__(self, **kwargs: Any):
            self.__dict__.update(kwargs)


INAM_A2A_EXTENSION_URI = "https://inamprotocol.org/ext/a2a/v1"
BASE_URL = os.environ.get("INAM_BASE_URL", "https://api.inamprotocol.org")

# Reads are public; the client still wants a keypair, so a throwaway one is fine here.
_client = InamClient(BASE_URL, generate_keypair())


def _normalize(url: str) -> Optional[str]:
    # ponytail: approximates WHATWG URL.href (lowercase scheme/host, default port, empty path);
    # percent-encoding and IDN differences are not normalized.
    try:
        p = urlsplit(url.strip())
        if not p.scheme or not p.netloc:
            return None
        default = {"http": 80, "https": 443}.get(p.scheme.lower())
        host = (p.hostname or "") + (f":{p.port}" if p.port and p.port != default else "")
        auth = p.netloc.rsplit("@", 1)[0] + "@" if "@" in p.netloc else ""
        return urlunsplit((p.scheme.lower(), auth + host, p.path or "/", p.query, p.fragment)).rstrip("/")
    except ValueError:
        return None


def card_endpoints(card: Dict[str, Any]) -> List[str]:
    """A2A 1.0 `supportedInterfaces[].url`, and 0.3 `url` / `additionalInterfaces[].url`."""
    items = [card.get("url"), *(card.get("supportedInterfaces") or []), *(card.get("additionalInterfaces") or [])]
    urls = [x if isinstance(x, str) else (x or {}).get("url") for x in items]
    return [u for u in urls if isinstance(u, str)]


def decide_a2a(
    card: Dict[str, Any],
    agent: Dict[str, Any],
    reputation: Dict[str, Any],
    min_evidence: str = "countersigned",
    min_trust_score: float = 0,
) -> Dict[str, Any]:
    """Pure check, same rules and reasons as decideA2A in sdk-js."""
    base = {"did": agent["id"], "evidenceLevel": reputation.get("evidenceLevel"), "trustScore": reputation.get("trustScore")}
    if agent.get("revokedAt"):
        return {**base, "allow": False, "reason": "INAM ID is revoked"}
    linked_raw = (agent.get("linked") or {}).get("a2a_endpoint")
    linked = linked_raw and _normalize(linked_raw)
    if not linked or not any(_normalize(u) == linked for u in card_endpoints(card)):
        return {**base, "allow": False, "reason": "no endpoint on this card is the a2a_endpoint the INAM ID linked"}
    failed = policy_failure(reputation, min_evidence, min_trust_score)
    return {**base, "allow": not failed, "reason": failed or "ok"}


def check_a2a_agent(agent_card_url: str, min_evidence: str = "countersigned", min_trust_score: float = 0) -> Dict[str, Any]:
    """Check an A2A agent against INAM before delegating a task to it.

    Fetches the Agent Card at `agent_card_url`, reads the INAM ID it names,
    and looks that ID up in the INAM registry. Returns `allow` (true/false)
    and a `reason`. Only delegate when `allow` is true. `min_evidence` is
    'none', 'countersigned' or 'independently_verified'; 'countersigned'
    means only the two parties vouched for past work, so do not read a high
    trustScore alone as proof of quality.
    """
    try:
        req = urllib.request.Request(agent_card_url, headers={"accept": "application/json", "user-agent": "inam-adk-example"})
        with urllib.request.urlopen(req, timeout=10) as res:
            card = json.loads(res.read().decode("utf-8"))
    except Exception as e:  # network error, non-2xx, or not JSON: no card, no delegation
        return {"allow": False, "reason": f"could not fetch Agent Card: {e}"}
    exts = ((card.get("capabilities") or {}).get("extensions")) or []
    did = next((((e.get("params") or {}).get("did")) for e in exts if e.get("uri") == INAM_A2A_EXTENSION_URI), None)
    if not isinstance(did, str):
        return {"allow": False, "reason": "card names no INAM ID"}
    try:
        agent = _client.get_agent(did)
        reputation = _client.get_reputation(did)
    except InamApiError:
        return {"allow": False, "did": did, "reason": "INAM ID not found in the registry"}
    return decide_a2a(card, agent, reputation, min_evidence, min_trust_score)


root_agent = Agent(
    name="inam_delegator",
    model="gemini-2.5-flash",
    description="Delegates tasks to remote A2A agents only after checking them on INAM.",
    instruction=(
        "Before delegating any task to a remote A2A agent, call check_a2a_agent with its Agent Card URL. "
        "Delegate only if the result has allow=true. Otherwise tell the user the reason and do not delegate."
    ),
    tools=[check_a2a_agent],
)


if __name__ == "__main__":
    print(json.dumps(check_a2a_agent(sys.argv[1]), indent=2))
