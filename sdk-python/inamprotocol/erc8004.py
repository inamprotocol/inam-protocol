"""INAM receipts as ERC-8004 feedback (SPEC.md §11.1) -- a port of sdk-js/src/erc8004.ts.

The receipt's requester gives the feedback from the EVM address its INAM ID
proved control of (``linked.erc8004_id``). The feedback file carries the whole
signed receipt and ``feedbackHash`` is the keccak256 of the file's bytes, so a
reader can check the feedback is backed by work both parties signed.
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .canonical import canonicalize
from .client import InamApiError
from .keys import from_base64, verify
from .receipt import compute_receipt_id
from .secp256k1 import keccak256

INAM_FEEDBACK_TAG = "inam-receipt"
OUTCOME_VALUE = {"success": 100, "partial": 50, "failed": 0}


def _keccak_hex(text: str) -> str:
    return "0x" + keccak256(text.encode("utf-8")).hex()


def build_erc8004_feedback(
    receipt: Dict[str, Any],
    requester: Dict[str, Any],
    agent_registry: str,
    agent_id: int,
    endpoint: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Feedback for a finalized, public receipt. ``requester`` is the receipt's agentA record; its
    ``linked.erc8004_id`` is the wallet that must send ``giveFeedback``. Returns ``file_text`` (the exact
    bytes to host at feedbackURI), ``feedback_hash``, and ``args`` for giveFeedback minus feedbackURI."""
    if receipt.get("status") != "finalized":
        raise ValueError("only a finalized receipt can back feedback")
    if receipt.get("visibility") == "participants_only":
        raise ValueError("a participants_only receipt would become public in the feedback file")
    if requester["id"] != receipt["agentA"]["id"]:
        raise ValueError("requester must be the receipt's agentA")
    address = (requester.get("linked") or {}).get("erc8004_id")
    if not address:
        raise ValueError("the requester's INAM ID has no linked erc8004_id to give feedback from")

    chain = ":".join(agent_registry.split(":")[:2])
    value = OUTCOME_VALUE[receipt["verification"]["outcome"]]
    tag2 = receipt["task"]["capability"]
    if created_at is None:
        created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    signed = {k: v for k, v in receipt.items() if k not in ("status", "dispute", "visibility")}
    file = {
        "agentRegistry": agent_registry,
        "agentId": agent_id,
        "clientAddress": f"{chain}:{address}",
        "createdAt": created_at,
        "value": value,
        "valueDecimals": 0,
        "tag1": INAM_FEEDBACK_TAG,
        "tag2": tag2,
        "endpoint": endpoint or None,  # omitted when empty, like the TypeScript SDK
        "inam": {"receipt": signed},
    }
    file_text = canonicalize(file)
    feedback_hash = _keccak_hex(file_text)
    args = {"agentId": agent_id, "value": value, "valueDecimals": 0, "tag1": INAM_FEEDBACK_TAG, "tag2": tag2, "endpoint": endpoint or "", "feedbackHash": feedback_hash}
    return {"file_text": file_text, "feedback_hash": feedback_hash, "args": args}


def verify_erc8004_feedback(file_text: str, feedback_hash: str, client_address: str, client: Any, value: Optional[int] = None) -> Dict[str, Any]:
    """Checks feedback read from ERC-8004 against the INAM receipt it carries. ``feedback_hash``,
    ``client_address`` and ``value`` come from the on-chain NewFeedback event. Returns ``valid``, every
    failed check in ``reasons``, and the provider's INAM ID and proven address to compare with the
    on-chain agent's owner or agentWallet."""
    reasons: List[str] = []
    if _keccak_hex(file_text).lower() != feedback_hash.lower():
        reasons.append("feedbackHash does not match the file")

    try:
        file = json.loads(file_text)
    except json.JSONDecodeError:
        return {"valid": False, "reasons": reasons + ["file is not JSON"]}
    r = (file.get("inam") or {}).get("receipt")
    sigs = (r or {}).get("signatures") or {}
    if not sigs.get("agentA") or not sigs.get("agentB"):
        return {"valid": False, "reasons": reasons + ["file carries no signed INAM receipt"]}

    if compute_receipt_id(r["agentA"]["id"], r["agentB"]["id"], r) != r["receiptId"]:
        reasons.append("receiptId does not match the receipt content")
    message = canonicalize({k: v for k, v in r.items() if k != "signatures"}).encode("utf-8")
    if not verify(from_base64(sigs["agentB"]), message, r["agentB"]["id"]):
        reasons.append("provider (agentB) signature is invalid")
    if not verify(from_base64(sigs["agentA"]), message, r["agentA"]["id"]):
        reasons.append("requester (agentA) signature is invalid")

    outcome = r["verification"]["outcome"]
    v = file.get("value") if value is None else value
    if v != OUTCOME_VALUE.get(outcome):
        reasons.append(f"value {v} does not match receipt outcome {outcome}")

    sender = client_address.lower()
    if file.get("clientAddress") and file["clientAddress"].split(":")[-1].lower() != sender:
        reasons.append("file clientAddress differs from the on-chain sender")

    requester = provider = stored = None
    try:
        requester = client.get_agent(r["agentA"]["id"])
        provider = client.get_agent(r["agentB"]["id"])
        stored = client.get_receipt(r["receiptId"])
    except InamApiError:
        reasons.append("receipt or its parties not found in the registry")
    if requester is not None and ((requester.get("linked") or {}).get("erc8004_id") or "").lower() != sender:
        reasons.append("feedback was not sent from the requester's proven erc8004_id")
    if stored is not None and stored.get("status") != "finalized":
        reasons.append(f"receipt is {stored.get('status')} in the registry")

    return {
        "valid": not reasons,
        "reasons": reasons,
        "receipt_id": r["receiptId"],
        "provider_did": r["agentB"]["id"],
        "provider_address": ((provider or {}).get("linked") or {}).get("erc8004_id"),
    }
