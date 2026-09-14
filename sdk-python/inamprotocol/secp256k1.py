"""ECDSA secp256k1 -- offered alongside Ed25519/P-256 for external-identity
challenge proofs (SPEC.md's external-identity linking section, v0.18) so an
ERC-8004 (EVM) identity can prove control of its key without any bridge
curve -- secp256k1 is the curve every Ethereum wallet already uses.

Digest = keccak256("\\x19Ethereum Signed Message:\\n32" + challenge), i.e.
Ethereum's standard `personal_sign` prefix over the 32 raw challenge bytes.
This means a real EVM wallet (MetaMask, viem, ethers `signMessage`) can
produce a valid proof signature with zero custom code on the caller's side --
the whole point of adding this curve.

`cryptography`'s EC API only speaks DER-encoded signatures; this SDK's own
wire format (matching sdk-js/src/crypto/secp256k1.ts) uses the 64-byte
compact r||s encoding instead, so this module converts at the boundary --
same pattern as p256.py. Keccak256 isn't available in `cryptography` or the
stdlib, so this module uses `pycryptodome` for it.
"""

from dataclasses import dataclass

from Crypto.Hash import keccak
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature

# secp256k1 group order -- needed to canonicalize signatures to "low-S" form
# below, same reasoning as p256.py's _P256_ORDER.
_SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def keccak256(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def eth_personal_sign_digest(message: bytes) -> bytes:
    prefix = f"\x19Ethereum Signed Message:\n{len(message)}".encode()
    return keccak256(prefix + message)


def eth_address_from_uncompressed_public_key(public_key: bytes) -> str:
    """Derives the lowercase 0x-prefixed Ethereum address for an uncompressed
    secp256k1 public key: "0x" + hex(keccak256(pubkey[1:]))[-40:] -- the same
    self-certifying principle INAM's own did:key uses. Required so an
    erc8004_id link can't claim an address unrelated to the key it just
    proved possession of."""
    if len(public_key) != 65 or public_key[0] != 0x04:
        raise ValueError("expected an uncompressed secp256k1 public key (65 bytes, 0x04 prefix)")
    digest = keccak256(public_key[1:])
    return "0x" + digest[-20:].hex()


@dataclass
class Secp256k1Keypair:
    public_key: bytes  # uncompressed SEC1, 65 bytes (0x04 || X || Y)
    private_key: ec.EllipticCurvePrivateKey


def generate_secp256k1_keypair() -> Secp256k1Keypair:
    private_key = ec.generate_private_key(ec.SECP256K1())
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return Secp256k1Keypair(public_key=public_bytes, private_key=private_key)


def secp256k1_sign(message: bytes, private_key: ec.EllipticCurvePrivateKey) -> bytes:
    digest = eth_personal_sign_digest(message)
    der_sig = private_key.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    r, s = decode_dss_signature(der_sig)
    # Same low-S canonicalization as p256.py: `cryptography` doesn't
    # normalize S, but @noble/curves' verifier rejects non-canonical
    # "high-S" signatures by default.
    if s > _SECP256K1_ORDER // 2:
        s = _SECP256K1_ORDER - s
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def secp256k1_verify(signature: bytes, message: bytes, public_key: bytes) -> bool:
    try:
        if len(signature) != 64:
            return False
        r = int.from_bytes(signature[:32], "big")
        s = int.from_bytes(signature[32:], "big")
        if s > _SECP256K1_ORDER // 2:
            return False  # reject non-canonical high-S, matching @noble/curves' default
        der_sig = encode_dss_signature(r, s)
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), public_key)
        digest = eth_personal_sign_digest(message)
        pub.verify(der_sig, digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        return True
    except Exception:
        return False
