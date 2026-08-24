# inamprotocol (Python SDK)

Reference Python client for the INAM Protocol — parity with the TypeScript `InamClient` in [`../sdk-js/src/client.ts`](../sdk-js/src/client.ts). See [`../SPEC.md`](../SPEC.md) for the full protocol specification.

## Install (development)

```
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -e . pytest   # Windows
# ./.venv/bin/python -m pip install -e . pytest          # macOS/Linux
```

## Test

```
./.venv/Scripts/python.exe -m pytest -v
```

`tests/test_interop.py` is the important one: it checks this SDK's `did:key` encoding, canonical JSON, and Ed25519 signing against fixed values generated once by the TypeScript reference implementation (`../scripts/interop-vectors.ts`). If a change here ever breaks that test, a receipt signed by this SDK would stop verifying against a registry or another SDK written in a different language — that's the whole point of the test.

## Usage

```python
from inamprotocol import InamClient, generate_keypair

keypair = generate_keypair()
client = InamClient("http://localhost:4021", keypair)

profile = client.register_agent(["document-extraction"], {"name": "My Agent"})
print(profile["id"])  # did:key:z...

reputation = client.get_reputation(profile["id"])
```

### Jobs (post -> offer -> accept -> execute -> receipt)

```python
from datetime import datetime, timezone

now = datetime.now(timezone.utc).isoformat()
job = poster.post_job("document-extraction", "sha256:...")
worker.submit_offer(job["jobId"], "I can do this in an hour")
poster.accept_offer(job["jobId"], worker.did)

receipt = worker.submit_work(poster.did, {
    "jobId": job["jobId"],
    "task": {"capability": "document-extraction", "specHash": "sha256:...", "createdAt": now},
    "result": {"outputHash": "sha256:...", "completedAt": now},
    "verification": {"method": "payer_confirmation", "outcome": "success"},
})
poster.accept_work(receipt)  # finalizes the receipt and auto-completes the job
```

`poster.cancel_job(job["jobId"])` cancels a not-yet-completed job (poster only); `client.get_job(id)` / `client.search_jobs(capability=..., status=...)` / `client.list_offers(job_id)` round out discovery.

### External identity linking (challenge-response)

Linking a key-derived external identity (`agentpass_id` / `aitp_id` / `passport_id`; SPEC.md section 2.1) requires proving control of that external key via a single-use, ~60s challenge. `a2a_endpoint` isn't key-derived, so it skips straight to `link_identity(protocol, value)`. See `examples/interop_worker.py` for this in a full running script.

```python
# external_keypair stands in for whatever key AgentPass/AITP/Passport
# Alliance already issued this agent -- not an INAM keypair.
challenge = client.request_link_challenge("agentpass_id", to_base64(external_keypair.public_key), "ed25519")
proof = to_base64(sign(from_hex(challenge["challenge"]), external_keypair.private_key))
client.complete_link("agentpass_id", "ap_my_external_id", challenge["challengeId"], proof)
```

### Verification (independent attestation)

A third party -- anyone but the receipt's own worker (`agentB`) -- can attest that a finalized receipt's output actually holds up (SPEC.md section 12), feeding a reputation boost:

```python
verification = verifier_client.submit_verification(
    receipt_id=receipt["receiptId"],
    method="deterministic",  # or "agent_attestation"
    output_hash=receipt["result"]["outputHash"],
    result="verified",  # or "rejected"
)

verifier_client.get_verification(verification["verificationId"])
verifier_client.list_receipt_verifications(receipt["receiptId"])
```

See `examples/interop_worker.py` for a full worker-side flow (register, link an external identity, submit signed Execution Receipt drafts), and `../scripts/run-interop-demo.sh` for the end-to-end cross-language demo (a TypeScript requester and this Python worker doing real business through the same live registry).
