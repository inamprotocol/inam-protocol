"""INAM receipts as ERC-8004 feedback (SPEC.md §11.1), end to end with no chain
writes, plus the allow/escrow/deny trust check. A requester and a provider each
link an EVM address, finish one job, and the requester builds giveFeedback
arguments from the countersigned receipt; a reader checks them. Run against a
local `npm run dev` server (default); it writes receipts, so not production.
"""

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inamprotocol import (  # noqa: E402
    InamClient,
    build_erc8004_feedback,
    check_trust,
    generate_keypair,
    to_base64,
    verify_erc8004_feedback,
)
from inamprotocol.keys import sha256_hex  # noqa: E402
from inamprotocol.secp256k1 import (  # noqa: E402
    eth_address_from_uncompressed_public_key,
    generate_secp256k1_keypair,
    secp256k1_sign,
)

BASE_URL = os.environ.get("INAM_URL", "http://localhost:4021")
if not BASE_URL.startswith(("http://localhost", "http://127.0.0.1")):
    raise SystemExit("refusing to write to a non-local registry")


def link_wallet(client: InamClient) -> str:
    wallet = generate_secp256k1_keypair()
    address = eth_address_from_uncompressed_public_key(wallet.public_key)
    ch = client.request_link_challenge("erc8004_id", to_base64(wallet.public_key), "secp256k1")
    proof = secp256k1_sign(bytes.fromhex(ch["challenge"]), wallet.private_key)
    client.complete_link("erc8004_id", address, ch["challengeId"], to_base64(proof))
    return address


def main():
    provider = InamClient(BASE_URL, generate_keypair())
    requester = InamClient(BASE_URL, generate_keypair())
    provider.register_agent(["translation.tr-en"], {"name": "8004 demo provider (py)", "demo": True})
    requester.register_agent(["translation.buyer"], {"name": "8004 demo requester (py)", "demo": True})
    link_wallet(provider)
    requester_address = link_wallet(requester)

    now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    output_hash = f"sha256:{sha256_hex('translated README')}"
    draft = provider.submit_work(requester.did, {
        "jobId": f"job_py_{int(time.time() * 1000)}",
        "task": {"capability": "translation.tr-en", "specHash": f"sha256:{sha256_hex('translate the README')}", "createdAt": now},
        "result": {"outputHash": output_hash, "completedAt": now},
        "verification": {"method": "payer_confirmation", "outcome": "success"},
    })
    receipt = requester.accept_work(draft, {"jobId": draft["jobId"], "outputHash": output_hash})

    print("provider trust:", check_trust(provider.did, requester)["reasons"])

    registry = "eip155:84532:0x0000000000000000000000000000000000008004"  # placeholder Identity Registry
    fb = build_erc8004_feedback(receipt, requester.get_agent(requester.did), registry, 42)
    print("giveFeedback from", requester_address, fb["args"])

    reader = InamClient(BASE_URL, generate_keypair())
    ok = verify_erc8004_feedback(fb["file_text"], fb["feedback_hash"], requester_address, reader, value=fb["args"]["value"])
    print("genuine feedback:", "valid" if ok["valid"] else ok["reasons"])
    sybil = verify_erc8004_feedback(fb["file_text"], fb["feedback_hash"], "0x000000000000000000000000000000000000dEaD", reader)
    print("replayed from another wallet:", sybil["reasons"])


if __name__ == "__main__":
    main()
