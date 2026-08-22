import os

from inamprotocol.keys import generate_keypair, sign, verify_raw_ed25519
from inamprotocol.p256 import generate_p256_keypair, p256_sign, p256_verify


def test_verify_raw_ed25519_round_trip():
    kp = generate_keypair()
    message = b"proof of control"
    signature = sign(message, kp.private_key)
    assert verify_raw_ed25519(signature, message, kp.public_key) is True


def test_verify_raw_ed25519_rejects_wrong_key():
    signer = generate_keypair()
    impostor = generate_keypair()
    message = b"proof of control"
    signature = sign(message, signer.private_key)
    assert verify_raw_ed25519(signature, message, impostor.public_key) is False


def test_p256_sign_and_verify_round_trip():
    kp = generate_p256_keypair()
    challenge = os.urandom(32)
    signature = p256_sign(challenge, kp.private_key)
    assert len(signature) == 64  # compact r||s, matching ATTP / sdk-js
    assert p256_verify(signature, challenge, kp.public_key) is True


def test_p256_rejects_tampered_challenge():
    kp = generate_p256_keypair()
    signature = p256_sign(b"\x01" * 32, kp.private_key)
    assert p256_verify(signature, b"\x02" * 32, kp.public_key) is False


def test_p256_rejects_wrong_key():
    signer = generate_p256_keypair()
    impostor = generate_p256_keypair()
    challenge = os.urandom(32)
    signature = p256_sign(challenge, signer.private_key)
    assert p256_verify(signature, challenge, impostor.public_key) is False


def test_p256_public_key_is_compressed_sec1():
    kp = generate_p256_keypair()
    assert len(kp.public_key) == 33
    assert kp.public_key[0] in (0x02, 0x03)


def test_p256_signatures_are_always_canonical_low_s():
    """@noble/curves (sdk-js / the Node+Worker servers) rejects non-canonical
    "high-S" ECDSA signatures by default, but raw `cryptography` signing
    doesn't normalize S -- about half of unnormalized signatures would be
    high-S and silently fail to verify cross-language. Run enough iterations
    that a regression here (removing the low-S fix in p256_sign) would almost
    certainly be caught rather than randomly passing."""
    order = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
    kp = generate_p256_keypair()
    for _ in range(64):
        signature = p256_sign(os.urandom(32), kp.private_key)
        s = int.from_bytes(signature[32:], "big")
        assert s <= order // 2
