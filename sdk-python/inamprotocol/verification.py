"""Pure verification-content logic (SPEC.md section 12) -- must match
sdk-js/src/core/verificationContent.ts."""

from typing import Any, Dict, Optional

from .canonical import canonicalize
from .keys import sha256_hex


def compute_verification_id(input: Dict[str, Any]) -> str:
    base = {
        "receiptId": input["receiptId"],
        "jobId": input["jobId"],
        "provider": input["provider"],
        "verifier": input["verifier"],
        "method": input["method"],
        "outputHash": input["outputHash"],
        "result": input["result"],
        "score": input.get("score"),
        "evidenceUri": input.get("evidenceUri"),
    }
    return f"sha256:{sha256_hex(canonicalize(base))}"


def build_signable_verification_content(input: Dict[str, Any]) -> Dict[str, Any]:
    verification_id = compute_verification_id(input)
    return {
        "verificationVersion": "1.0",
        "verificationId": verification_id,
        "receiptId": input["receiptId"],
        "jobId": input["jobId"],
        "provider": input["provider"],
        "verifier": input["verifier"],
        "method": input["method"],
        "outputHash": input["outputHash"],
        "result": input["result"],
        "score": input.get("score"),
        "evidenceUri": input.get("evidenceUri"),
    }
