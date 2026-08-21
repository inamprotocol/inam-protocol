"""Canonical JSON serialization — must match src/crypto/canonical.ts byte-for-byte.

This is the one piece of logic every INAM SDK, in any language, has to agree
on precisely: receipt signatures are verified by independently re-canonicalizing
the same structured data on the other side, so any divergence here would make
cross-language signatures fail to verify. See SPEC.md section 7.
"""

import json
from typing import Any


def canonicalize(value: Any) -> str:
    return _stringify(value)


def _stringify(value: Any) -> str:
    if isinstance(value, dict):
        keys = sorted(value.keys())
        entries = []
        for key in keys:
            v = value[key]
            if v is None:
                # Mirrors the JS side filtering out `undefined`-valued keys —
                # None is our cross-language stand-in for "field omitted",
                # never a meaningful JSON null in these schemas.
                continue
            entries.append(json.dumps(key, ensure_ascii=False) + ":" + _stringify(v))
        return "{" + ",".join(entries) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_stringify(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False)
