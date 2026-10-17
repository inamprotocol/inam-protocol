import hashlib
import json
from pathlib import Path

import pytest

from inamprotocol.canonical import canonicalize

# Shared with the JS SDK (tests/canonicalVectors.test.ts): non-ASCII and non-BMP canonical JSON.
_FILE = Path(__file__).resolve().parents[2] / "interop" / "canonical" / "vectors.json"
VECTORS = json.loads(_FILE.read_text(encoding="utf-8"))["vectors"]


@pytest.mark.parametrize("v", VECTORS, ids=[v["name"] for v in VECTORS])
def test_matches_js_reference(v):
    out = canonicalize(v["input"])
    assert out == v["canonical"]
    assert hashlib.sha256(out.encode("utf-8")).hexdigest() == v["utf8Sha256"]
