"""Allow / escrow / deny trust decision -- a port of sdk-js/src/trust.ts.

Decided on the caller's side from the registry's appraisal, which is a hint
(SPEC.md §5.4). "escrow" means: deal, but don't release payment until delivery
is confirmed. INAM holds no money, so the escrow runs on the caller's own rail.
Reason strings match the TypeScript SDK exactly.
"""

from typing import Any, Dict, List, Optional

from .canonical import _format_number
from .client import InamApiError

EVIDENCE_RANK = {"none": 0, "countersigned": 1, "independently_verified": 2}
DEFAULT_ESCROW_FLAGS = ["in_dispute", "attestation_rejected", "nonperformance_reported", "concentrated_counterparty"]


def policy_failure(reputation: Dict[str, Any], min_evidence: str = "countersigned", min_trust_score: float = 0) -> Optional[str]:
    """Why ``reputation`` misses the bar, or None if it meets it."""
    level = reputation["evidenceLevel"]
    if EVIDENCE_RANK[level] < EVIDENCE_RANK[min_evidence]:
        return f"evidence {level} is below {min_evidence}"
    if reputation["trustScore"] < min_trust_score:
        return f"trustScore {_format_number(reputation['trustScore'])} is below {_format_number(min_trust_score)}"
    return None


def decide_trust(
    agent: Dict[str, Any],
    reputation: Dict[str, Any],
    allow: Optional[Dict[str, Any]] = None,
    escrow: Optional[Dict[str, Any]] = None,
    escrow_flags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """``allow``/``escrow`` take ``min_evidence`` and ``min_trust_score``. Defaults: allow needs
    independently verified evidence; escrow needs nothing, so unknown-but-registered agents get escrow;
    a revoked ID is denied. Flags in ``escrow_flags`` (prefix match) cap the decision at escrow."""
    base = {"did": agent["id"], "reputation": reputation}
    if agent.get("revokedAt"):
        return {**base, "decision": "deny", "reasons": ["INAM ID is revoked"]}

    escrow_miss = policy_failure(reputation, **{"min_evidence": "none", **(escrow or {})})
    if escrow_miss:
        return {**base, "decision": "deny", "reasons": [escrow_miss]}

    reasons: List[str] = []
    allow_miss = policy_failure(reputation, **{"min_evidence": "independently_verified", **(allow or {})})
    if allow_miss:
        reasons.append(allow_miss)
    watch = DEFAULT_ESCROW_FLAGS if escrow_flags is None else escrow_flags
    for flag in reputation.get("flags") or []:
        if any(flag == w or flag.startswith(f"{w}:") for w in watch):
            reasons.append(f"flag {flag}")

    if reasons:
        return {**base, "decision": "escrow", "reasons": reasons}
    score = _format_number(reputation["trustScore"])
    return {**base, "decision": "allow", "reasons": [f"evidence {reputation['evidenceLevel']}, trustScore {score}"]}


def check_trust(did: str, client: Any, **policy: Any) -> Dict[str, Any]:
    """Fetches ``did`` from the registry ``client`` points at and decides. An ID the registry doesn't know is "deny"."""
    try:
        agent = client.get_agent(did)
        reputation = client.get_reputation(did)
    except InamApiError:
        return {"did": did, "decision": "deny", "reasons": ["INAM ID not found in the registry"]}
    return decide_trust(agent, reputation, **policy)
