"""did:key (Ed25519) identity — must match src/crypto/keys.ts."""

import base64
import hashlib
from dataclasses import dataclass
from typing import Union

import base58
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization

# multicodec value for ed25519-pub (0xed) as a varint: [0xed, 0x01].
ED25519_MULTICODEC_PREFIX = bytes([0xED, 0x01])


@dataclass
class Keypair:
    did: str
    public_key: bytes
    private_key: Ed25519PrivateKey


def public_key_to_did(public_key: bytes) -> str:
    prefixed = ED25519_MULTICODEC_PREFIX + public_key
    return "did:key:z" + base58.b58encode(prefixed).decode("ascii")


def did_to_public_key(did: str) -> bytes:
    if not did.startswith("did:key:z"):
        raise ValueError(f"Unsupported DID method: {did}")
    decoded = base58.b58decode(did[len("did:key:z") :])
    if decoded[0:2] != ED25519_MULTICODEC_PREFIX:
        raise ValueError(f"Unsupported key type in DID: {did}")
    return decoded[2:]


def generate_keypair() -> Keypair:
    private_key = Ed25519PrivateKey.generate()
    return keypair_from_private_key(private_key)


def keypair_from_raw_private_key(raw_private_key: bytes) -> Keypair:
    private_key = Ed25519PrivateKey.from_private_bytes(raw_private_key)
    return keypair_from_private_key(private_key)


def keypair_from_private_key(private_key: Ed25519PrivateKey) -> Keypair:
    public_bytes = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return Keypair(did=public_key_to_did(public_bytes), public_key=public_bytes, private_key=private_key)


def sign(message: bytes, private_key: Ed25519PrivateKey) -> bytes:
    return private_key.sign(message)


# edwards25519 has cofactor 8, so there are exactly 8 small-order (low-order
# torsion) points on the curve -- for any of them, standard Ed25519
# verification is satisfiable by arbitrary signature bytes with no private
# key at all (must match sdk-js/src/crypto/keys.ts's isSmallOrderPublicKey,
# which rejects the same set via `Point.fromHex(key).isSmallOrder()`; this
# fixed 8-entry blacklist is the equivalent check without a full curve
# library -- derived by scalar-multiplying a random curve point by the
# prime subgroup order L to land in the torsion subgroup, then enumerating
# its 8 multiples, each independently confirmed small-order via noble's
# isSmallOrder()).
_SMALL_ORDER_PUBLIC_KEYS = frozenset(
    bytes.fromhex(h)
    for h in (
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    )
)


def _is_small_order_public_key(public_key: bytes) -> bool:
    return public_key in _SMALL_ORDER_PUBLIC_KEYS


def verify(signature: bytes, message: bytes, did: str) -> bool:
    try:
        raw = did_to_public_key(did)
        if _is_small_order_public_key(raw):
            return False
        public_key = Ed25519PublicKey.from_public_bytes(raw)
        public_key.verify(signature, message)
        return True
    except Exception:
        return False


def verify_raw_ed25519(signature: bytes, message: bytes, public_key: bytes) -> bool:
    """Verifies against a raw Ed25519 public key rather than a did:key -- for
    externally-issued identities (e.g. an AgentPass/AITP key) that aren't
    necessarily encoded as an INAM did:key."""
    try:
        if _is_small_order_public_key(public_key):
            return False
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, message)
        return True
    except Exception:
        return False


def sha256_hex(data: Union[str, bytes]) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def from_base64(s: str) -> bytes:
    return base64.b64decode(s)


def to_hex(data: bytes) -> str:
    return data.hex()


def from_hex(s: str) -> bytes:
    return bytes.fromhex(s)
