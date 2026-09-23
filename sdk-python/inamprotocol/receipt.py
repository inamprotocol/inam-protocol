"""Pure receipt-content logic — must match src/core/receiptContent.ts."""

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from .canonical import canonicalize
from .keys import sha256_hex


def compute_receipt_id(agent_a_id: str, agent_b_id: str, input: Dict[str, Any]) -> str:
    base = {
        "jobId": input["jobId"],
        "agentA": {"id": agent_a_id, "role": "requester"},
        "agentB": {"id": agent_b_id, "role": "worker"},
        "task": input["task"],
        "result": input["result"],
        "settlement": input.get("settlement"),
        "verification": input["verification"],
    }
    return f"sha256:{sha256_hex(canonicalize(base))}"


def build_signable_content(agent_a_id: str, agent_b_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
    receipt_id = compute_receipt_id(agent_a_id, agent_b_id, input)
    return {
        "receiptVersion": "1.0",
        "receiptId": receipt_id,
        "jobId": input["jobId"],
        "agentA": {"id": agent_a_id, "role": "requester"},
        "agentB": {"id": agent_b_id, "role": "worker"},
        "task": input["task"],
        "result": input["result"],
        "settlement": input.get("settlement"),
        "verification": input["verification"],
        "dispute": {"status": "none", "windowClosesAt": None},
    }


def dispute_window_closes_at(receipt: Dict[str, Any]) -> Optional[datetime]:
    """SPEC.md §4.3 (v0.31): ``dispute.windowClosesAt`` is None until a receipt
    is countersigned. Returns a timezone-aware datetime, or None when the value
    is missing, None, or unparseable (including the "" that pre-v0.31
    registries returned for drafts). Mirrors sdk-js ``disputeWindowClosesAt``."""
    raw = (receipt.get("dispute") or {}).get("windowClosesAt")
    if not raw or not isinstance(raw, str):
        return None
    try:
        # fromisoformat only accepts a trailing "Z" from Python 3.11 on.
        parsed = datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_dispute_window_open(receipt: Dict[str, Any], now: Optional[datetime] = None) -> bool:
    """True only while a dispute window exists and hasn't closed yet. A draft has no window, so it's False."""
    closes_at = dispute_window_closes_at(receipt)
    return closes_at is not None and (now or datetime.now(timezone.utc)) < closes_at
