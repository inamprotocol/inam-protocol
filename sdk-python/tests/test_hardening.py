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
        "receiptId": "sha256:f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
        "jobId": "job_fixture",
        "agentA": {"id": "did:key:zAgentA", "role": "requester"},
        "agentB": {"id": "did:key:zAgentB", "role": "worker"},
        "task": {"capability": "x", "specHash": "sha256:d4f02eaafd1a9e9de7d10972ca8e47fa7a985825c3c9c1e249c72683cb3e4f19", "createdAt": "2026-01-01T00:00:00.000Z"},
        "result": {"outputHash": "sha256:762069bc07a6e1b5df123a5ae7bd91c10daa04694fbaa17fba0cd6a8dcce8f22", "completedAt": "2026-01-01T00:01:00.000Z"},
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
        client.accept_work(receipt, expected={"outputHash": "sha256:9d6f965ac832e40a5df6c06afe983e3b449c07b843ff51ce76204de05c690d11"})
