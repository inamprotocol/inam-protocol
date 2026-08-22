"""End-to-end demo of the Verification resource (SPEC.md section 12) through
the Python SDK: register a requester/provider/verifier, finalize a receipt,
then have the independent verifier submit a signed attestation of it -- and
watch the provider's reputation pick up the attestedReceipts boost. Run
against a local `npm run dev` server (default) or a live deployment via
INAM_URL.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inamprotocol import InamClient, generate_keypair  # noqa: E402

BASE_URL = os.environ.get("INAM_URL", "http://localhost:4021")


def main():
    requester = InamClient(BASE_URL, generate_keypair())
    provider = InamClient(BASE_URL, generate_keypair())
    verifier = InamClient(BASE_URL, generate_keypair())
    requester.register_agent(["job.posting"])
    provider.register_agent(["document-extraction"])
    verifier.register_agent(["verification"])
    print(f"[verification_demo] requester={requester.did}")
    print(f"[verification_demo] provider={provider.did}")
    print(f"[verification_demo] verifier={verifier.did}")

    now = datetime.now(timezone.utc).isoformat()
    draft = provider.submit_work(
        requester.did,
        {
            "jobId": "job_verification_python_demo",
            "task": {"capability": "document-extraction", "specHash": "sha256:spec_verify_demo", "createdAt": now},
            "result": {"outputHash": "sha256:out_verify_demo", "completedAt": now},
            "verification": {"method": "payer_confirmation", "outcome": "success"},
        },
    )
    finalized = requester.accept_work(draft)
    print(f"[verification_demo] receipt finalized: {finalized['receiptId']}")
    assert finalized["status"] == "finalized"

    before = requester.get_reputation(provider.did)
    print(f"[verification_demo] provider reputation before verification: attestedReceipts={before['components']['attestedReceipts']}, trustScore={before['trustScore']}")

    record = verifier.submit_verification(
        receipt_id=finalized["receiptId"],
        method="deterministic",
        output_hash=finalized["result"]["outputHash"],
        result="verified",
        score=0.97,
    )
    print(f"[verification_demo] submitted verification {record['verificationId']} (result={record['result']})")
    assert record["result"] == "verified"
    assert record["provider"] == provider.did

    fetched = verifier.get_verification(record["verificationId"])
    assert fetched["verificationId"] == record["verificationId"]

    listed = verifier.list_receipt_verifications(finalized["receiptId"])
    assert any(v["verificationId"] == record["verificationId"] for v in listed["verifications"])

    after = requester.get_reputation(provider.did)
    print(f"[verification_demo] provider reputation after verification: attestedReceipts={after['components']['attestedReceipts']}, trustScore={after['trustScore']}")
    assert after["components"]["attestedReceipts"] == 1
    assert after["trustScore"] > before["trustScore"]

    print("\n[verification_demo] All checks passed.")


if __name__ == "__main__":
    main()
