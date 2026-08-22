"""Cross-language correctness for the Verification resource (SPEC.md section
12). These expected values were generated once by the TypeScript reference
implementation (see ../../scripts/interop-vectors.ts, same fixed test-only
private key as test_interop.py). If Python's compute_verification_id /
build_signable_verification_content / canonicalize / Ed25519 signing ever
diverges from the TypeScript side, this test fails -- that divergence is
exactly what would make a verification signed by one language's SDK fail to
verify against a registry (or another SDK) written in the other language.
"""

import base64

from inamprotocol.canonical import canonicalize
from inamprotocol.keys import keypair_from_raw_private_key, sign, to_base64, verify
from inamprotocol.verification import build_signable_verification_content, compute_verification_id

# --- Ground truth from `npx tsx scripts/interop-vectors.ts` ---
PRIVATE_KEY_HEX = "01" * 32
EXPECTED_DID = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"

VERIFICATION_INPUT = {
    "receiptId": "sha256:receipt_interop_1",
    "jobId": "job_interop_1",
    "provider": "did:key:zExampleProvider",
    "verifier": EXPECTED_DID,
    "method": "deterministic",
    "outputHash": "sha256:out",
    "result": "verified",
    "score": 0.98,
}

EXPECTED_VERIFICATION_ID = "sha256:ad7d8aa49bcd5e638dc37e81b1210afbe17d96850500ff0692f637a5b51ac823"
EXPECTED_CANONICAL = (
    '{"jobId":"job_interop_1","method":"deterministic","outputHash":"sha256:out",'
    '"provider":"did:key:zExampleProvider","receiptId":"sha256:receipt_interop_1",'
    '"result":"verified","score":0.98,'
    '"verificationId":"sha256:ad7d8aa49bcd5e638dc37e81b1210afbe17d96850500ff0692f637a5b51ac823",'
    '"verificationVersion":"1.0","verifier":"did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"}'
)
EXPECTED_SIGNATURE_B64 = "btkcD74oc7rX68lDMLKK4vtHwTvihfVkN+adslrRdns1h5vuE3zPLMEA7z5a9E9du3wx/J5Lm8QJcojkTPL6DQ=="


def test_verification_id_matches_typescript():
    assert compute_verification_id(VERIFICATION_INPUT) == EXPECTED_VERIFICATION_ID


def test_signable_verification_content_canonical_matches_typescript():
    content = build_signable_verification_content(VERIFICATION_INPUT)
    assert content["verificationId"] == EXPECTED_VERIFICATION_ID
    assert content["verificationVersion"] == "1.0"
    assert canonicalize(content) == EXPECTED_CANONICAL


def test_verification_signature_is_byte_identical_to_typescript():
    # Ed25519 signatures are deterministic (RFC 8032) -- the same key and
    # message MUST produce the exact same signature in any correct
    # implementation, not just one that happens to verify.
    kp = keypair_from_raw_private_key(bytes.fromhex(PRIVATE_KEY_HEX))
    content = build_signable_verification_content(VERIFICATION_INPUT)
    signing_bytes = canonicalize(content).encode("utf-8")
    signature = sign(signing_bytes, kp.private_key)
    assert to_base64(signature) == EXPECTED_SIGNATURE_B64


def test_python_verifies_a_typescript_produced_verification_signature():
    content = build_signable_verification_content(VERIFICATION_INPUT)
    signing_bytes = canonicalize(content).encode("utf-8")
    signature = base64.b64decode(EXPECTED_SIGNATURE_B64)
    assert verify(signature, signing_bytes, EXPECTED_DID) is True
    assert verify(signature, b"tampered", EXPECTED_DID) is False
