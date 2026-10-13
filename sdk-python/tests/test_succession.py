"""Key succession (SPEC.md section 2.3): the statement both keys sign must be
byte-identical to the TypeScript reference (vectors from
`npx tsx scripts/interop-vectors.ts`, field `succession`), and the client must
send both signatures."""

from inamprotocol.client import InamClient
from inamprotocol.keys import keypair_from_raw_private_key, from_base64, verify
from inamprotocol.succession import succession_signing_bytes, verify_succession

PREDECESSOR = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"
SUCCESSOR = "did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH"
EXPECTED_CANONICAL = (
    '{"predecessor":"did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX",'
    '"successor":"did:key:z6Mko9hTggMwjSTEaJaPUfE6tqcy2xvU6BnNq3e3o8qVBiyH",'
    '"type":"inam.succession.v1"}'
)
TS_RECORD = {
    "predecessor": PREDECESSOR,
    "successor": SUCCESSOR,
    "predecessorSignature": "Ysk2KgVsXejgcSVEwZxk4TdSxdE/t2sZS9VSXJ7Cw1/0c4CB8As/4AqBP57tJBjNwhd+/SkCc4Bfx11Qn/7XDA==",
    "successorSignature": "KTxOwLAkgYrmW4SZ3zJdVYAQbB1UDE3Qm4jFPpZy2m8rxlAfHynOo9hUNQBpAvuFAv4SwQZ8Jyy+W9+/s2OdCA==",
}

old = keypair_from_raw_private_key(bytes([1]) * 32)
new = keypair_from_raw_private_key(bytes([2]) * 32)


def test_statement_bytes_match_typescript():
    assert (old.did, new.did) == (PREDECESSOR, SUCCESSOR)
    assert succession_signing_bytes(PREDECESSOR, SUCCESSOR) == EXPECTED_CANONICAL.encode("utf-8")


def test_verifies_typescript_record_and_rejects_tampering():
    assert verify_succession(TS_RECORD) is True
    assert verify_succession({**TS_RECORD, "successor": PREDECESSOR}) is False
    swapped = {**TS_RECORD, "predecessorSignature": TS_RECORD["successorSignature"]}
    assert verify_succession(swapped) is False


def test_client_sends_both_signatures_byte_identical_to_typescript():
    client = InamClient("http://example.invalid", old)
    captured = {}

    def fake_request(method, path, body=None, idempotency_key=None):
        captured.update(method=method, path=path, body=body)
        return {}

    client._request = fake_request
    client.succeed(new)
    assert captured["path"].endswith("/succeed")
    body = captured["body"]
    assert body["successor"] == SUCCESSOR
    assert body["predecessorSignature"] == TS_RECORD["predecessorSignature"]
    assert body["successorSignature"] == TS_RECORD["successorSignature"]
    assert verify(from_base64(body["successorSignature"]), EXPECTED_CANONICAL.encode(), SUCCESSOR)


def test_payer_and_trust_checks_refuse_a_succeeded_id():
    from inamprotocol.trust import decide_trust
    from inamprotocol.x402 import decide_x402

    agent = {"id": PREDECESSOR, "linked": {"erc8004_id": "0xabc"}, "succeededBy": SUCCESSOR}
    rep = {"evidenceLevel": "independently_verified", "trustScore": 90, "flags": []}
    assert decide_x402(agent, rep, ["0xabc"])["allow"] is False
    assert decide_trust(agent, rep)["decision"] == "deny"


def test_cancel_succession_is_a_revoke_and_pending_caps_trust_at_escrow():
    from inamprotocol.trust import decide_trust

    client = InamClient("http://example.invalid", old)
    captured = {}

    def fake_request(method, path, body=None, idempotency_key=None):
        captured.update(path=path, body=body)
        return {}

    client._request = fake_request
    client.cancel_succession("not mine")
    assert captured["path"].endswith("/revoke") and captured["body"] == {"reason": "not mine"}

    agent = {"id": PREDECESSOR, "linked": {}}
    rep = {"evidenceLevel": "independently_verified", "trustScore": 90, "flags": [f"succession_pending:{SUCCESSOR}"]}
    assert decide_trust(agent, rep)["decision"] == "escrow"
