"""Canonical JSON serialization — must match src/crypto/canonical.ts byte-for-byte.

This is the one piece of logic every INAM SDK, in any language, has to agree
on precisely: receipt/verification signatures are verified by independently
re-canonicalizing the same structured data on the other side (always with the
TypeScript implementation, since the server -- Node and Worker alike -- is
TypeScript), so any divergence here makes a Python-signed request fail
verification even though nothing was tampered with. See SPEC.md section 7.

Number formatting is the sharp edge here, and it bit us for real: Python's
`json.dumps` renders floats via Python's own repr rules (`1.0`, `1e-07`,
`1e+20`, `-0.0`), while JavaScript's `JSON.stringify` renders numbers via the
ECMA-262 `Number::toString` algorithm (`1`, `1e-7`, `100000000000000000000`,
`0`). These disagree for ordinary, unremarkable values -- `score: 1.0` was
observed live to produce `INVALID_VERIFICATION_SIGNATURE` while `score: 0.99`
did not, purely because of this formatting gap, not any actual tampering.
`_format_number` below reimplements the ECMA-262 algorithm so Python produces
the exact same digit string JavaScript would for the same value.

Note on `None`/null: this module still treats a `None` value as "field
omitted" (dropped entirely, not emitted as JSON `null`) -- NOT changed as
part of this fix, even though it means this module's null-handling isn't a
literal byte-for-byte port of the JS side (which only drops `undefined`
and keeps an explicit `null`). Left as is deliberately: every current content
builder (verification.py, receipt.py) unconditionally includes optional keys
via `input.get(...)`, defaulting to `None` when the caller omitted them --
mirroring the JS side's `score?: number` object-spread, which omits the key
entirely via `undefined` when not passed. Flipping `None` to a real `null`
here without first changing every content builder to conditionally omit the
key would make Python emit `"score":null` for the common "not provided" case
while JS omits the key entirely -- a regression, not a fix. A real JSON-null
value (as opposed to "omitted") isn't currently signed by any field in this
protocol; if one is ever added, the content builder for it needs to
conditionally include/omit the key the way the JS side does, not rely on
this function to paper over the difference.
"""

import json
import math
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
                continue
            entries.append(json.dumps(key, ensure_ascii=False) + ":" + _stringify(v))
        return "{" + ",".join(entries) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_stringify(v) for v in value) + "]"
    if isinstance(value, bool):
        # bool is a subclass of int in Python -- must be checked before the
        # int/float numeric branch below, or True/False would be formatted
        # as numbers instead of JSON's `true`/`false`.
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _format_number(value)
    return json.dumps(value, ensure_ascii=False)


def _format_number(value: Any) -> str:
    """Render a number exactly as JavaScript's `JSON.stringify` would (the
    ECMA-262 `Number::toString` algorithm), not as Python's `repr`/`json.dumps`
    would. Raises ValueError for NaN/Infinity -- these have no JSON
    representation at all (JS's `JSON.stringify(NaN)` silently produces the
    string `"null"`, which would corrupt a signature without ever raising an
    error on either side, so both languages must reject them outright before
    they ever reach this function)."""
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 2**53 - 1:
            # JS numbers are IEEE 754 doubles; integers past 2^53-1 can't be
            # represented exactly, so there is no well-defined cross-language
            # canonical form to agree on. Every numeric field this protocol
            # signs today (Verification.score, 0..1) is far inside this
            # range -- this guards a currently-hypothetical future field.
            raise ValueError(f"integer {value} exceeds the safe range for canonical JSON (+/-(2^53-1))")
        f = float(value)
    else:
        f = value

    if math.isnan(f):
        raise ValueError("NaN cannot be canonicalized -- JSON has no representation for it")
    if math.isinf(f):
        raise ValueError("Infinity cannot be canonicalized -- JSON has no representation for it")

    if f == 0.0:
        # JS: `JSON.stringify(-0)` === "0" -- the sign is dropped, for both
        # +0 and -0. Python's `repr(-0.0)` is "-0.0"; without this special
        # case the two sides would disagree on this one value the same way
        # they did on 1.0.
        return "0"

    neg = f < 0
    f = abs(f)

    # Python's `repr(float)` (since 3.1) already computes the shortest
    # decimal digit string that round-trips back to the same double -- the
    # same property JS's algorithm guarantees -- so the *digits* always
    # agree between the two languages. What differs is only the surface
    # formatting (fixed vs. exponential notation, the exponent threshold,
    # trailing ".0", exponent sign/padding). So: extract the digit string
    # and decimal-point position from Python's repr, in whichever notation
    # Python happened to choose, then re-render using JS's own rules rather
    # than trusting Python's formatting choice.
    repr_str = repr(f)
    if "e" in repr_str:
        mantissa, exp_str = repr_str.split("e")
        exp = int(exp_str)
    else:
        mantissa, exp = repr_str, 0
    if "." in mantissa:
        int_part, frac_part = mantissa.split(".")
    else:
        int_part, frac_part = mantissa, ""

    digits = int_part + frac_part
    n = len(int_part) + exp  # decimal-point position, counted in `digits`

    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0") or "0"
    k = len(digits)

    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        mantissa_out = digits if k == 1 else digits[0] + "." + digits[1:]
        exp_val = n - 1
        out = f"{mantissa_out}e{'+' if exp_val >= 0 else '-'}{abs(exp_val)}"

    return ("-" if neg else "") + out
