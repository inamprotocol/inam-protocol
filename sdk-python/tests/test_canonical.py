import pytest

from inamprotocol.canonical import canonicalize


# Each pair here is (python value, exact string JavaScript's JSON.stringify
# produces for the same logical value) -- confirmed by hand against a real
# Node process, not assumed. This is the live bug: a Verification submitted
# with `score: 1.0` from Python failed signature verification against the
# TypeScript server (always TS, Node and Worker alike) with
# INVALID_VERIFICATION_SIGNATURE, purely because `json.dumps(1.0)` produces
# "1.0" while `JSON.stringify(1.0)` produces "1" -- not because of any
# tampering. This table is the regression guard for that class of bug.
JS_NUMBER_VECTORS = [
    (1.0, "1"),
    (0.0, "0"),
    (-0.0, "0"),
    (0.000001, "0.000001"),
    (0.0000001, "1e-7"),
    (1e20, "100000000000000000000"),
    (100.0, "100"),
    (0.99, "0.99"),
    (-1.5, "-1.5"),
    (123456789.123, "123456789.123"),
    (1, "1"),  # a plain Python int, not just a float
]


@pytest.mark.parametrize("value,expected", JS_NUMBER_VECTORS)
def test_number_formatting_matches_javascript(value, expected):
    assert canonicalize(value) == expected


def test_score_one_point_zero_matches_js_not_python_repr():
    # The exact live-reproduced case: Python's own repr/json.dumps would
    # render this "1.0"; the canonical form (and what a TS-side verifier
    # re-derives) must be "1".
    assert canonicalize({"score": 1.0}) == '{"score":1}'
    assert canonicalize({"score": 1.0}) != '{"score":1.0}'


def test_rejects_nan_and_infinity():
    with pytest.raises(ValueError):
        canonicalize(float("nan"))
    with pytest.raises(ValueError):
        canonicalize(float("inf"))
    with pytest.raises(ValueError):
        canonicalize(float("-inf"))
    with pytest.raises(ValueError):
        canonicalize({"score": float("nan")})


def test_key_order_independence():
    a = canonicalize({"b": 1, "a": 2, "c": {"z": 1, "y": 2}})
    b = canonicalize({"c": {"y": 2, "z": 1}, "a": 2, "b": 1})
    assert a == b


def test_drops_none_valued_keys():
    assert canonicalize({"a": 1, "b": None}) == '{"a":1}'


def test_preserves_array_order():
    assert canonicalize([3, 1, 2]) == "[3,1,2]"


def test_sensitive_to_value_change():
    assert canonicalize({"amount": "12.50"}) != canonicalize({"amount": "12.51"})
