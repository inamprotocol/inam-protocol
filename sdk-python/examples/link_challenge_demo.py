"""End-to-end demo of external-identity link challenges through the Python
SDK: request a challenge, sign it with an *external* key (not the INAM
keypair), and complete the link -- for both Ed25519 and P-256 (ATTP's primary
curve). Run against a local `npm run dev` server (default) or a live
deployment via INAM_URL.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inamprotocol import (  # noqa: E402
    InamClient,
    generate_keypair,
    generate_p256_keypair,
    p256_sign,
    sign,
    to_base64,
    from_hex,
)

BASE_URL = os.environ.get("INAM_URL", "http://localhost:4021")


def main():
    agent = InamClient(BASE_URL, generate_keypair())
    agent.register_agent(["x"])
    print(f"[link_challenge_demo] agent={agent.did}")

    # --- Ed25519 external identity (e.g. an aitp_id) ---
    external_ed = generate_keypair()
    challenge = agent.request_link_challenge("aitp_id", to_base64(external_ed.public_key), "ed25519")
    print(f"[link_challenge_demo] challenge issued: {challenge['challengeId']}")
    proof = to_base64(sign(from_hex(challenge["challenge"]), external_ed.private_key))
    linked = agent.complete_link("aitp_id", "aitp:python-demo", challenge["challengeId"], proof)
    print(f"[link_challenge_demo] linked aitp_id -> {linked['linked']['aitp_id']}")
    assert linked["linked"]["aitp_id"] == "aitp:python-demo"

    # --- P-256 external identity (ATTP's primary curve, e.g. agentpass_id) ---
    external_p256 = generate_p256_keypair()
    challenge2 = agent.request_link_challenge("agentpass_id", to_base64(external_p256.public_key), "p256")
    proof2 = to_base64(p256_sign(from_hex(challenge2["challenge"]), external_p256.private_key))
    linked2 = agent.complete_link("agentpass_id", "agentpass:python-demo", challenge2["challengeId"], proof2)
    print(f"[link_challenge_demo] linked agentpass_id -> {linked2['linked']['agentpass_id']}")
    assert linked2["linked"]["agentpass_id"] == "agentpass:python-demo"

    print("\n[link_challenge_demo] All checks passed.")


if __name__ == "__main__":
    main()
