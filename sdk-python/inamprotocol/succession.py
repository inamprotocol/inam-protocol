"""Key succession (SPEC.md section 2.3) -- must match sdk-js/src/core/succession.ts."""

from typing import Any, Dict

from .canonical import canonicalize
from .keys import from_base64, verify

SUCCESSION_TYPE = "inam.succession.v1"


def succession_signing_bytes(predecessor: str, successor: str) -> bytes:
    """The exact bytes both keys sign: canonical JSON of the statement, UTF-8."""
    return canonicalize({"type": SUCCESSION_TYPE, "predecessor": predecessor, "successor": successor}).encode("utf-8")


def verify_succession(record: Dict[str, Any]) -> bool:
    """True only if both signatures verify over the statement. Checkable offline."""
    if record["predecessor"] == record["successor"]:
        return False
    try:
        data = succession_signing_bytes(record["predecessor"], record["successor"])
        return verify(from_base64(record["predecessorSignature"]), data, record["predecessor"]) and verify(
            from_base64(record["successorSignature"]), data, record["successor"]
        )
    except Exception:
        return False
