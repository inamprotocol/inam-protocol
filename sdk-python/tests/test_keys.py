from inamprotocol.keys import generate_keypair, did_to_public_key, sign, verify


def test_did_key_round_trip():
    kp = generate_keypair()
    assert kp.did.startswith("did:key:z")
    assert did_to_public_key(kp.did) == kp.public_key


def test_sign_and_verify():
    kp = generate_keypair()
    message = b"hello inam"
    signature = sign(message, kp.private_key)
    assert verify(signature, message, kp.did) is True


def test_rejects_tampered_message():
    kp = generate_keypair()
    signature = sign(b"original", kp.private_key)
    assert verify(signature, b"tampered", kp.did) is False


def test_rejects_wrong_signer():
    signer = generate_keypair()
    impostor = generate_keypair()
    message = b"hello inam"
    signature = sign(message, signer.private_key)
    assert verify(signature, message, impostor.did) is False
