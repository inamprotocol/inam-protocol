"""ECDSA P-256 -- used alongside Ed25519 for external-identity challenge
proofs (SPEC.md's external-identity linking section), because P-256 is the
primary curve ATTP (draft-sharif-attp-00, the protocol AgentPass is built on)
mandates: "Each agent MUST have a unique ECDSA key pair using the P-256
curve." Not used anywhere else in INAM -- the protocol's own did:key identity
stays Ed25519-only.

`cryptography`'s EC API only speaks DER-encoded signatures; ATTP (and this
SDK's own wire format, matching sdk-js/src/crypto/p256.ts) uses the 64-byte
compact r||s encoding instead, so this module converts at the boundary.
"""

from dataclasses import dataclass

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

# secp256r1 (P-256) group order -- needed to canonicalize signatures to
# "low-S" form below.
_P256_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


@dataclass
class P256Keypair:
    public_key: bytes  # SEC1 compressed, 33 bytes
    private_key: ec.EllipticCurvePrivateKey


def generate_p256_keypair() -> P256Keypair:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.CompressedPoint,
    )
    return P256Keypair(public_key=public_bytes, private_key=private_key)


def p256_sign(message: bytes, private_key: ec.EllipticCurvePrivateKey) -> bytes:
    der_sig = private_key.sign(message, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_sig)
    # `cryptography` doesn't normalize S, but @noble/curves' verifier (the
    # sdk-js / Worker / Node side) rejects non-canonical "high-S" signatures
    # by default, per standard ECDSA malleability protection -- so a raw
    # `cryptography` signature verifies correctly about half the time and
    # fails the other half depending on which of the two equally-valid (r, s)
    # / (r, n-s) representations OpenSSL happened to produce. Canonicalize to
    # low-S here so this SDK's signatures always verify against sdk-js.
    if s > _P256_ORDER // 2:
        s = _P256_ORDER - s
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def p256_verify(signature: bytes, message: bytes, public_key: bytes) -> bool:
    try:
        if len(signature) != 64:
            return False
        r = int.from_bytes(signature[:32], "big")
        s = int.from_bytes(signature[32:], "big")
        der_sig = encode_dss_signature(r, s)
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), public_key)
        pub.verify(der_sig, message, ec.ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False
