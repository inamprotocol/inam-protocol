import os

from inamprotocol.keys import generate_keypair, sign, verify_raw_ed25519
from inamprotocol.p256 import generate_p256_keypair, p256_sign, p256_verify
from inamprotocol.secp256k1 import (
    generate_secp256k1_keypair,
    secp256k1_sign,
    secp256k1_verify,
    eth_address_from_uncompressed_public_key,
)


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


def test_secp256k1_sign_and_verify_round_trip():
    kp = generate_secp256k1_keypair()
    challenge = os.urandom(32)
    signature = secp256k1_sign(challenge, kp.private_key)
    assert len(signature) == 64  # compact r||s, matching sdk-js
    assert secp256k1_verify(signature, challenge, kp.public_key) is True


def test_secp256k1_rejects_tampered_challenge():
    kp = generate_secp256k1_keypair()
    signature = secp256k1_sign(b"\x01" * 32, kp.private_key)
    assert secp256k1_verify(signature, b"\x02" * 32, kp.public_key) is False


def test_secp256k1_rejects_wrong_key():
    signer = generate_secp256k1_keypair()
    impostor = generate_secp256k1_keypair()
    challenge = os.urandom(32)
    signature = secp256k1_sign(challenge, signer.private_key)
    assert secp256k1_verify(signature, challenge, impostor.public_key) is False


def test_secp256k1_public_key_is_uncompressed_sec1():
    kp = generate_secp256k1_keypair()
    assert len(kp.public_key) == 65
    assert kp.public_key[0] == 0x04


def test_secp256k1_signatures_are_always_canonical_low_s():
    """Same reasoning as test_p256_signatures_are_always_canonical_low_s --
    @noble/curves (sdk-js) rejects non-canonical "high-S" signatures by
    default."""
    order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    kp = generate_secp256k1_keypair()
    for _ in range(64):
        signature = secp256k1_sign(os.urandom(32), kp.private_key)
        s = int.from_bytes(signature[32:], "big")
        assert s <= order // 2


def test_eth_address_matches_known_vector():
    """keccak256(pubkey[1:])[-20:] cross-checked against a real, independently
    published Ethereum address rather than just an internal round-trip --
    the public key for private key 1 (G itself) is a well-known constant
    (0x7e5f...395bdf). A wrong hash choice (e.g. NIST SHA3-256 instead of
    Ethereum's original Keccak-256, which pycryptodome's keccak.new also
    happens to implement) would still pass a same-language round-trip test
    but silently produce an address no real wallet would ever recognize --
    exactly the class of bug this project has been burned by before (see
    p256.py's low-S docstring)."""
    Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
    Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
    pub = bytes([0x04]) + Gx.to_bytes(32, "big") + Gy.to_bytes(32, "big")
    assert eth_address_from_uncompressed_public_key(pub) == "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
