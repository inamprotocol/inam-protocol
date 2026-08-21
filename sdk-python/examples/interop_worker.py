"""Phase B of the TS <-> Python cross-language demo.

A Python-side "worker" agent registers itself against the same live registry
a TypeScript-side "requester" already registered with (see
../../scripts/interop-phase-a-register-requester.ts), then submits two
signed Execution Receipt drafts naming that requester as agent_a. Phase C
(TypeScript again) picks the drafts up and countersigns them -- proving the
protocol works end to end across languages, not just within one SDK.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inamprotocol import InamClient, generate_keypair  # noqa: E402

BASE_URL = os.environ.get("INAM_URL", "http://localhost:4021")
HANDOFF_PATH = Path(os.environ.get("INAM_HANDOFF", "../.interop-tmp/requester-identity.json"))


def main():
    handoff_path = HANDOFF_PATH
    if not handoff_path.is_absolute():
        handoff_path = (Path(__file__).resolve().parent / handoff_path).resolve()
    with open(handoff_path, "r", encoding="utf-8") as f:
        requester = json.load(f)
    requester_did = requester["did"]
    print(f"[phase B / Python] Found requester from phase A: {requester_did}")

    worker_kp = generate_keypair()
    client = InamClient(BASE_URL, worker_kp)
    profile = client.register_agent(["document-extraction"], {"name": "Python Worker (interop demo)"})
    print(f"[phase B / Python] Registered worker {profile['id']}")

    client.link_identity("agentpass_id", "ap_python_interop_demo")

    for i in (1, 2):
        now = datetime.now(timezone.utc).isoformat()
        draft = client.submit_work(
            requester_did,
            {
                "jobId": f"job_interop_{i}",
                "task": {"capability": "document-extraction", "specHash": f"sha256:spec_{i}", "createdAt": now},
                "result": {"outputHash": f"sha256:out_{i}", "completedAt": now},
                "settlement": {"amount": "20.00", "currency": "USDC", "paymentRef": f"x402:tx_py_{i}"},
                "verification": {"method": "payer_confirmation", "outcome": "success"},
            },
        )
        print(f"[phase B / Python] Submitted draft receipt {draft['receiptId']} (status={draft['status']})")

    worker_handoff = handoff_path.parent / "worker-identity.json"
    with open(worker_handoff, "w", encoding="utf-8") as f:
        json.dump({"did": worker_kp.did}, f)
    print(f"[phase B / Python] Worker DID for phase C to check: {worker_kp.did}")


if __name__ == "__main__":
    main()
