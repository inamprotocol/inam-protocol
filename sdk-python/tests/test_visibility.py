"""SPEC.md §4.4 (v0.19), audit #13: regression coverage for the countersign
signature-verification bug found while implementing this feature -- adding
`visibility` to ExecutionReceipt made accept_work's content-reconstruction
spread disagree with the server unless `visibility` is explicitly excluded
the same way `dispute`/`status` already are.
"""

from inamprotocol.canonical import canonicalize
from inamprotocol.client import InamClient
from inamprotocol.keys import generate_keypair


def test_accept_work_countersign_content_ignores_visibility():
    """A receipt with a `visibility` field must sign identically to one
    without it -- otherwise a real countersign against a live server (whose
    own reconstruction always excludes `visibility`) fails verification."""
    kp = generate_keypair()
    client = InamClient("http://example.invalid", kp)

    base_receipt = {
        "receiptId": "r1",
        "jobId": "job1",
        "agentA": {"id": "did:key:zA", "role": "requester"},
        "agentB": {"id": "did:key:zB", "role": "worker"},
        "task": {"capability": "x", "specHash": "sha256:s", "createdAt": "2026-01-01T00:00:00.000Z"},
        "result": {"outputHash": "sha256:o", "completedAt": "2026-01-01T00:01:00.000Z"},
        "verification": {"method": "payer_confirmation", "outcome": "success"},
        "signatures": {"agentB": "sig"},
        "status": "draft",
        "dispute": None,
    }
    receipt_with_visibility = {**base_receipt, "visibility": "participants_only"}

    captured = {}

    def fake_request(method, path, body=None, idempotency_key=None):
        captured["signature"] = body["signature"]
        return {}

    client._request = fake_request

    client.accept_work(base_receipt)
    signature_without = captured["signature"]
    client.accept_work(receipt_with_visibility)
    signature_with = captured["signature"]

    assert signature_with == signature_without


def test_submit_work_passes_visibility_through_to_the_request_body():
    kp = generate_keypair()
    client = InamClient("http://example.invalid", kp)
    captured = {}

    def fake_request(method, path, body=None, idempotency_key=None):
        captured["body"] = body
        return {}

    client._request = fake_request

    input = {
        "jobId": "job1",
        "task": {"capability": "x", "specHash": "sha256:s", "createdAt": "2026-01-01T00:00:00.000Z"},
        "result": {"outputHash": "sha256:o", "completedAt": "2026-01-01T00:01:00.000Z"},
        "verification": {"method": "payer_confirmation", "outcome": "success"},
    }

    client.submit_work("did:key:zA", input, visibility="participants_only")
    assert captured["body"]["visibility"] == "participants_only"

    # Omitted, not None: the server's schema treats `visibility` as an
    # optional (missing) key, not a nullable one -- an explicit
    # `"visibility": null` over the wire is a VALIDATION_ERROR. This was a
    # real bug (found by cross-checking this SDK against the Zod schema,
    # not caught by this test before the fix, since it never serialized to
    # real JSON): json.dumps doesn't drop None values on its own.
    client.submit_work("did:key:zA", input)
    assert "visibility" not in captured["body"]


def test_canonicalize_drops_none_valued_keys_matching_undefined_in_js():
    """The bug's exact mechanism: canonicalize must treat a `None`-valued key
    as absent, matching sdk-js's canonical.ts dropping `undefined` keys --
    otherwise excluding `visibility` with `None` wouldn't actually help."""
    assert canonicalize({"a": 1, "visibility": None}) == canonicalize({"a": 1})
