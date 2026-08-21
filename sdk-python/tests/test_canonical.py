from inamprotocol.canonical import canonicalize


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
