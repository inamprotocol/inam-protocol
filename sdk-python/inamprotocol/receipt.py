"""Pure receipt-content logic — must match src/core/receiptContent.ts."""

from typing import Any, Dict

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
        "dispute": {"status": "none", "windowClosesAt": ""},
    }
