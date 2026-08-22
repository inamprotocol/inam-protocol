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


def verify(signature: bytes, message: bytes, did: str) -> bool:
    try:
        public_key = Ed25519PublicKey.from_public_bytes(did_to_public_key(did))
        public_key.verify(signature, message)
        return True
    except Exception:
        return False


def verify_raw_ed25519(signature: bytes, message: bytes, public_key: bytes) -> bool:
    """Verifies against a raw Ed25519 public key rather than a did:key -- for
    externally-issued identities (e.g. an AgentPass/AITP key) that aren't
    necessarily encoded as an INAM did:key."""
    try:
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
