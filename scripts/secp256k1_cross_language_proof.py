"""Companion to secp256k1-cross-language-proof.ts (SPEC.md v0.18) -- reads the
TS-signed vector, verifies it with sdk-python, then signs the same challenge
with a fresh Python keypair for the TS side to verify back. Run:

    npx tsx scripts/secp256k1-cross-language-proof.ts sign
    python scripts/secp256k1_cross_language_proof.py
    npx tsx scripts/secp256k1-cross-language-proof.ts verify-python
"""

import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk-python"))

from inamprotocol.secp256k1 import (  # noqa: E402
    generate_secp256k1_keypair,
    secp256k1_sign,
    secp256k1_verify,
    eth_address_from_uncompressed_public_key,
)

VECTOR_PATH = os.path.join(os.path.dirname(__file__), "secp256k1-cross-language-vector.json")

with open(VECTOR_PATH) as f:
    data = json.load(f)

public_key = base64.b64decode(data["publicKey"])
challenge = bytes.fromhex(data["challenge"])
ts_sig = base64.b64decode(data["tsSignature"])

ok = secp256k1_verify(ts_sig, challenge, public_key)
print("Python verifying TS-produced signature:", ok)
derived_address = eth_address_from_uncompressed_public_key(public_key)
print("address match:", derived_address == data["address"], derived_address, data["address"])
if not ok or derived_address != data["address"]:
    sys.exit(1)

kp = generate_secp256k1_keypair()
py_sig = secp256k1_sign(challenge, kp.private_key)
data["pythonSignature"] = base64.b64encode(py_sig).decode()
# Overwrite publicKey/address with the Python-generated keypair for the return trip.
data["publicKey"] = base64.b64encode(kp.public_key).decode()
data["address"] = eth_address_from_uncompressed_public_key(kp.public_key)

with open(VECTOR_PATH, "w") as f:
    json.dump(data, f, indent=2)

print("Python signed with its own keypair. pythonSignature/publicKey/address written back.")
