"""External review's batch of small hardening findings (STATUS.md item 5,
SPEC.md v0.26). TypeScript mirrors live in tests/hardening.test.ts and
worker/tests/api.test.ts."""

import pytest

from inamprotocol.client import InamClient
from inamprotocol.keys import generate_keypair, public_key_to_did, verify, verify_raw_ed25519


def test_rejects_small_order_public_key_regardless_of_signature_bytes():
    # The order-2 point on edwards25519 (x=0, y=-1 mod p) -- for it, Ed25519
    # verification is satisfiable by arbitrary signature bytes with no
    # private key at all.
    small_order_key = bytes.fromhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")
    did = public_key_to_did(small_order_key)
    message = b"anything"
    garbage_signature = bytes(64)
    assert verify(garbage_signature, message, did) is False
    assert verify_raw_ed25519(garbage_signature, message, small_order_key) is False


def _fixture_receipt(**overrides):
    receipt = {
        "receiptId": "sha256:fixture",
        "jobId": "job_fixture",
        "agentA": {"id": "did:key:zAgentA", "role": "requester"},
        "agentB": {"id": "did:key:zAgentB", "role": "worker"},
        "task": {"capability": "x", "specHash": "sha256:spec", "createdAt": "2026-01-01T00:00:00.000Z"},
        "result": {"outputHash": "sha256:out", "completedAt": "2026-01-01T00:01:00.000Z"},
        "verification": {"method": "payer_confirmation", "outcome": "success"},
        "dispute": {"status": "none", "windowClosesAt": None},
        "signatures": {"agentB": "sig"},
        "status": "draft",
        "visibility": "public",
    }
    receipt.update(overrides)
    return receipt


def test_accept_work_refuses_to_sign_when_not_the_receipts_agent_a():
    requester = generate_keypair()
    client = InamClient("http://127.0.0.1:1", requester)
    receipt = _fixture_receipt(agentA={"id": "did:key:zSomeoneElse", "role": "requester"})
    with pytest.raises(ValueError, match="not the receipt's agentA"):
        client.accept_work(receipt)


def test_accept_work_refuses_to_sign_on_expected_mismatch():
    requester = generate_keypair()
    client = InamClient("http://127.0.0.1:1", requester)
    receipt = _fixture_receipt(agentA={"id": requester.did, "role": "requester"})

    with pytest.raises(ValueError, match="expected jobId"):
        client.accept_work(receipt, expected={"jobId": "job_other"})
    with pytest.raises(ValueError, match="expected outputHash"):
        client.accept_work(receipt, expected={"outputHash": "sha256:different"})
