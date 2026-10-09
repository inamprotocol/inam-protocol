"""x402 verify-before-pay gate and its CounterpartyContext -- a port of the
pure parts of sdk-js/src/x402.ts (SPEC.md §11.2, x402 #1777).

A payee names its INAM ID in the 402's ``extensions.inam``. The payer pays only
a ``payTo`` that ID proved control of (``linked.erc8004_id``), and only if its
reputation meets the payer's policy. ``counterparty_context`` records what was
checked, hashed so anyone holding the policy input can recompute the decision.
Reason strings and hashes match the TypeScript SDK exactly
(tests/vectors/x402-counterparty-context.json).
"""

import urllib.parse
from typing import Any, Dict, List

from .canonical import canonicalize
from .keys import sha256_hex
from .trust import policy_failure

X402_POLICY_VERSION = "inam-x402-gate/1"


def decide_x402(
    agent: Dict[str, Any],
    reputation: Dict[str, Any],
    pay_to: List[str],
    min_evidence: str = "countersigned",
    min_trust_score: float = 0,
) -> Dict[str, Any]:
    """Pure policy check: ``{"allow", "reason", "did", "reputation"}``."""
    base = {"did": agent["id"], "reputation": reputation}
    if agent.get("revokedAt"):
        return {**base, "allow": False, "reason": "payee INAM ID is revoked"}
    bound = (agent.get("linked") or {}).get("erc8004_id")
    if not bound or bound.lower() not in (a.lower() for a in pay_to):
        return {**base, "allow": False, "reason": "payTo is not an address this INAM ID proved control of"}
    failed = policy_failure(reputation, min_evidence, min_trust_score)
    return {**base, "allow": not failed, "reason": failed or "ok"}


def x402_policy_input(
    agent: Dict[str, Any],
    reputation: Dict[str, Any],
    pay_to: List[str],
    request: Dict[str, str],
    min_evidence: str = "countersigned",
    min_trust_score: float = 0,
) -> Dict[str, Any]:
    """Exactly what ``decide_x402`` reads, with defaults applied. ``request`` has
    ``resource``, ``amount``, ``network`` and ``nonce``."""
    bound = (agent.get("linked") or {}).get("erc8004_id")
    return {
        "policy_version": X402_POLICY_VERSION,
        "policy": {"minEvidence": min_evidence, "minTrustScore": min_trust_score},
        "counterparty_did": agent["id"],
        "revoked": bool(agent.get("revokedAt")),
        "bound_wallet": bound.lower() if bound else None,
        "pay_to": [a.lower() for a in pay_to],
        "evidence_level": reputation["evidenceLevel"],
        "trust_score": reputation["trustScore"],
        "trust_profile_issued_at": ((reputation.get("evidence") or {}).get("freshness") or {}).get("evaluatedAt"),
        "requested_resource": request["resource"],
        "requested_amount": request["amount"],
        "chain_or_settlement_network": request["network"],
        "nonce_or_request_id": request["nonce"],
    }


def counterparty_context(
    agent: Dict[str, Any],
    reputation: Dict[str, Any],
    pay_to: List[str],
    request: Dict[str, str],
    min_evidence: str = "countersigned",
    min_trust_score: float = 0,
    registry_url: str = "https://api.inamprotocol.org",
) -> Dict[str, Any]:
    """A CounterpartyContext for one gate decision. ``policy_input_hash`` is
    sha256 over the JCS (RFC 8785) form of ``x402_policy_input``. Unsigned: it
    is the payer's own record of what it checked, not an attestation."""
    policy_input = x402_policy_input(agent, reputation, pay_to, request, min_evidence, min_trust_score)
    decision = decide_x402(agent, reputation, pay_to, min_evidence, min_trust_score)
    agent_url = f"{registry_url}/v1/agents/{urllib.parse.quote(agent['id'], safe='')}"
    return {
        "counterparty_did": agent["id"],
        "counterparty_wallet_or_account": policy_input["bound_wallet"],
        "wallet_binding_proof_ref": agent_url,
        "trust_profile_ref": f"{agent_url}/reputation",
        "trust_profile_issued_at": policy_input["trust_profile_issued_at"],
        "requested_resource": request["resource"],
        "requested_amount": request["amount"],
        "chain_or_settlement_network": request["network"],
        "nonce_or_request_id": request["nonce"],
        "policy_version": X402_POLICY_VERSION,
        "policy_input_canonicalization": "JCS (RFC 8785)",
        "policy_input_hash": f"sha256:{sha256_hex(canonicalize(policy_input, keep_null=True))}",
        "decision": "allow" if decision["allow"] else "deny",
        "reason": decision["reason"],
    }
