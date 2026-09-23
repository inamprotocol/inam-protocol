from datetime import datetime, timedelta, timezone

from inamprotocol import dispute_window_closes_at, is_dispute_window_open


def r(value):
    return {"dispute": {"windowClosesAt": value}}


def test_no_window_for_draft_missing_or_legacy_values():
    for value in (None, "", "not-a-date"):
        assert dispute_window_closes_at(r(value)) is None
        assert is_dispute_window_open(r(value)) is False
    assert dispute_window_closes_at({"dispute": {}}) is None


def test_real_window_open_then_closed():
    closes = "2026-09-26T18:54:05.162Z"
    parsed = dispute_window_closes_at(r(closes))
    assert parsed == datetime(2026, 9, 26, 18, 54, 5, 162000, tzinfo=timezone.utc)
    assert is_dispute_window_open(r(closes), now=parsed - timedelta(milliseconds=1)) is True
    assert is_dispute_window_open(r(closes), now=parsed) is False
