"""End-to-end demo of the Job resource (SPEC.md section 3) through the Python
SDK: post -> search -> offer -> accept -> submit work -> countersign -> the
job auto-completes. Run against a local `npm run dev` server (default) or a
live deployment via INAM_URL.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inamprotocol import InamClient, generate_keypair  # noqa: E402

BASE_URL = os.environ.get("INAM_URL", "http://localhost:4021")


def main():
    poster = InamClient(BASE_URL, generate_keypair())
    worker = InamClient(BASE_URL, generate_keypair())
    poster.register_agent(["job.posting"])
    worker.register_agent(["translation.tr-en"])
    print(f"[job_demo] poster={poster.did}")
    print(f"[job_demo] worker={worker.did}")

    job = poster.post_job("translation.tr-en", "sha256:spec_python_demo")
    print(f"[job_demo] posted job {job['jobId']} status={job['status']}")
    assert job["status"] == "open"

    found = poster.search_jobs(capability="translation.tr-en", status="open")
    assert any(j["jobId"] == job["jobId"] for j in found["jobs"])
    print("[job_demo] job discoverable via search_jobs")

    worker.submit_offer(job["jobId"], "I can do this")
    accepted = poster.accept_offer(job["jobId"], worker.did)
    print(f"[job_demo] offer accepted, job status={accepted['status']}")
    assert accepted["status"] == "accepted"

    now = datetime.now(timezone.utc).isoformat()
    draft = worker.submit_work(
        poster.did,
        {
            "jobId": job["jobId"],
            "task": {"capability": "translation.tr-en", "specHash": "sha256:spec_python_demo", "createdAt": now},
            "result": {"outputHash": "sha256:out_python_demo", "completedAt": now},
            "verification": {"method": "payer_confirmation", "outcome": "success"},
        },
    )
    finalized = poster.accept_work(draft)
    print(f"[job_demo] receipt finalized: {finalized['receiptId']}")
    assert finalized["status"] == "finalized"

    job_after = poster.get_job(job["jobId"])
    print(f"[job_demo] job after finalize: status={job_after['status']} receiptId={job_after.get('receiptId')}")
    assert job_after["status"] == "completed"
    assert job_after["receiptId"] == finalized["receiptId"]

    print("\n[job_demo] All checks passed.")


if __name__ == "__main__":
    main()
