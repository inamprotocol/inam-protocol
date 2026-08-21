"""Cross-language correctness: these expected values were generated once by the
TypeScript reference implementation (see ../../scripts/interop-vectors.ts) from
a fixed test-only private key. If the Python SDK's did:key encoding,
canonical-JSON serialization, or Ed25519 signing ever diverges from the
TypeScript side, this test fails — that divergence is exactly what would make
a receipt signed by one language's SDK fail to verify against a registry (or
another SDK) written in the other language.
"""

from inamprotocol.canonical import canonicalize
from inamprotocol.keys import keypair_from_raw_private_key, sign, to_base64, verify

# --- Ground truth from `npx tsx scripts/interop-vectors.ts` ---
PRIVATE_KEY_HEX = "01" * 32
EXPECTED_PUBLIC_KEY_HEX = "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"
EXPECTED_DID = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"
EXPECTED_CANONICAL = (
    '{"agentA":{"id":"did:key:zExampleA","role":"requester"},'
    '"agentB":{"id":"did:key:zExampleB","role":"worker"},'
    '"jobId":"job_interop_1",'
    '"result":{"completedAt":"2026-08-22T00:01:00.000Z","outputHash":"sha256:out"},'
    '"settlement":{"amount":"12.50","currency":"USDC"},'
    '"task":{"capability":"translation.tr-en","createdAt":"2026-08-22T00:00:00.000Z","specHash":"sha256:spec"},'
    '"verification":{"method":"payer_confirmation","outcome":"success"}}'
)
MESSAGE = b"inam-interop-test-message"
EXPECTED_SIGNATURE_B64 = "V3nIJGvwXXN+dNRM5gxyLeECY3fMVLu8baci/JrlArgeElTU3bEThOR7ipfJxGtHvWDIcrEzyIDq/vNkHVAJDA=="

SAMPLE_OBJECT = {
    "jobId": "job_interop_1",
    "agentA": {"id": "did:key:zExampleA", "role": "requester"},
    "agentB": {"id": "did:key:zExampleB", "role": "worker"},
    "task": {"capability": "translation.tr-en", "specHash": "sha256:spec", "createdAt": "2026-08-22T00:00:00.000Z"},
    "result": {"outputHash": "sha256:out", "completedAt": "2026-08-22T00:01:00.000Z"},
    "settlement": {"amount": "12.50", "currency": "USDC"},
    "verification": {"method": "payer_confirmation", "outcome": "success"},
}


def test_did_key_matches_typescript():
    kp = keypair_from_raw_private_key(bytes.fromhex(PRIVATE_KEY_HEX))
    assert kp.public_key.hex() == EXPECTED_PUBLIC_KEY_HEX
    assert kp.did == EXPECTED_DID


def test_canonical_json_matches_typescript():
    assert canonicalize(SAMPLE_OBJECT) == EXPECTED_CANONICAL


def test_signature_is_byte_identical_to_typescript():
    # Ed25519 signatures are deterministic (RFC 8032) — the same key and
    # message MUST produce the exact same signature in any correct
    # implementation, not just a signature that happens to verify.
    kp = keypair_from_raw_private_key(bytes.fromhex(PRIVATE_KEY_HEX))
    signature = sign(MESSAGE, kp.private_key)
    assert to_base64(signature) == EXPECTED_SIGNATURE_B64


def test_python_verifies_a_typescript_produced_signature():
    import base64

    kp_did = EXPECTED_DID
    signature = base64.b64decode(EXPECTED_SIGNATURE_B64)
    assert verify(signature, MESSAGE, kp_did) is True
    assert verify(signature, b"tampered message", kp_did) is False
