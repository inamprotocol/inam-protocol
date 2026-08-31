"""INAM Protocol reference client — parity with src/sdk/client.ts (InamClient).

Everything here is transport plumbing plus the two signature schemes (HTTP
request signing, receipt content signing). An agent framework's tool-calling
layer would wrap these same calls as `search_jobs` / `verify_agent` /
`submit_work`-style tools.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Dict, List, Optional

from .canonical import canonicalize
from .keys import Keypair, sha256_hex, sign, to_base64
from .receipt import build_signable_content
from .verification import build_signable_verification_content

try:
    _SDK_VERSION = version("inamprotocol")
except PackageNotFoundError:
    # Not installed as a package (e.g. running straight from a source
    # checkout without `pip install -e .`) -- fall back rather than crash.
    _SDK_VERSION = "0.0.0-dev"

# Read from the installed package's own metadata (pyproject.toml's
# `version`) instead of a hardcoded literal: a previous version of this
# string was pinned to "0.1.0" and silently never updated across four
# subsequent releases (0.2.0 through 0.4.0), so every request from every
# version of this SDK identified itself as the very first release.
_USER_AGENT = f"inamprotocol-python-sdk/{_SDK_VERSION}"


class InamApiError(Exception):
    def __init__(self, method: str, path: str, status: int, payload: Any):
        self.status = status
        self.payload = payload
        super().__init__(f"{method} {path} -> {status}: {payload}")


class InamClient:
    def __init__(self, base_url: str, keypair: Keypair):
        self.base_url = base_url.rstrip("/")
        self.keypair = keypair

    @property
    def did(self) -> str:
        return self.keypair.did

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        raw_body = json.dumps(body, separators=(",", ":")) if body is not None else ""
        timestamp = str(int(time.time() * 1000))
        body_hash = sha256_hex(raw_body)
        signing_string = f"{method.upper()}\n{path}\n{timestamp}\n{body_hash}"
        signature = to_base64(sign(signing_string.encode("utf-8"), self.keypair.private_key))

        headers = {
            "content-type": "application/json",
            # Cloudflare's bot protection on *.workers.dev flags Python's
            # default `Python-urllib/x.y` User-Agent; identify honestly instead.
            "user-agent": _USER_AGENT,
            "inam-agent": self.keypair.did,
            "inam-timestamp": timestamp,
            "inam-signature": signature,
        }
        if idempotency_key:
            headers["idempotency-key"] = idempotency_key

        url = f"{self.base_url}{path}"
        data = raw_body.encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            payload_text = e.read().decode("utf-8")
            try:
                payload = json.loads(payload_text)
            except json.JSONDecodeError:
                payload = payload_text
            raise InamApiError(method, path, e.code, payload) from None

    def register_agent(self, capabilities: List[str], metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        # Omit the key entirely rather than sending it as JSON null: the
        # server's zod schema treats `metadata` as optional-if-absent, not
        # nullable, and Python's json.dumps (unlike JS's JSON.stringify,
        # which drops `undefined`-valued keys) serializes None as null.
        body: Dict[str, Any] = {"capabilities": capabilities}
        if metadata is not None:
            body["metadata"] = metadata
        return self._request("POST", "/v1/agents", body, idempotency_key=f"register:{self.keypair.did}")

    def get_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/agents/{urllib.parse.quote(agent_id, safe='')}")

    def revoke(self, reason: str) -> Dict[str, Any]:
        """Retires this client's own INAM ID (SPEC.md Section 2.2). One-way --
        a revoked ID performs no further signed operations and drops out of
        search. The key-compromise / key-rotation-off tool: an INAM ID *is*
        its Ed25519 key, so a leaked key can't be re-pointed, only burned.
        Call this while you still control the key."""
        return self._request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(self.did, safe='')}/revoke",
            {"reason": reason},
            idempotency_key=f"revoke:{self.did}",
        )

    def set_verifier_status(self, target_agent_id: str, authorized: bool) -> Dict[str, Any]:
        """Grants or revokes `target_agent_id`'s verifier status (SPEC.md
        Section 12.3). Only succeeds when this client's own keypair is the
        registry's configured operator identity -- anyone else gets
        NOT_OPERATOR. There is no self-service path to becoming a verifier.
        """
        return self._request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(target_agent_id, safe='')}/verifier-status",
            {"authorized": authorized},
            idempotency_key=f"verifier-status:{target_agent_id}:{authorized}:{int(time.time() * 1000)}",
        )

    def link_identity(self, protocol: str, value: str) -> Dict[str, Any]:
        """Links `a2a_endpoint` -- the one protocol that isn't a key-derived
        identity, so there's nothing to prove control of beyond this
        request's own INAM signature. For `agentpass_id` / `aitp_id` /
        `passport_id`, use `request_link_challenge` + `complete_link` instead.
        """
        return self._request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(self.did, safe='')}/link",
            {"protocol": protocol, "value": value},
            idempotency_key=f"link:{protocol}:{value}",
        )

    def request_link_challenge(self, protocol: str, external_public_key: str, key_type: str) -> Dict[str, Any]:
        """Step 1 of linking a key-derived external identity: request a
        single-use, ~60s challenge that must be signed with the *external*
        private key corresponding to `external_public_key` (base64), not this
        INAM keypair."""
        return self._request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(self.did, safe='')}/link/challenge",
            {"protocol": protocol, "externalPublicKey": external_public_key, "keyType": key_type},
            idempotency_key=f"link-challenge:{protocol}:{external_public_key}:{time.time()}",
        )

    def complete_link(self, protocol: str, value: str, challenge_id: str, proof_signature: str) -> Dict[str, Any]:
        """Step 2: submit the signed challenge to complete the link.
        `proof_signature` must be a signature over the raw bytes of the
        challenge (hex-decoded) produced by the external private key,
        base64-encoded."""
        return self._request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(self.did, safe='')}/link",
            {"protocol": protocol, "value": value, "challengeId": challenge_id, "proofSignature": proof_signature},
            idempotency_key=f"link:{protocol}:{challenge_id}",
        )

    def search_agents(
        self,
        capability: Optional[str] = None,
        min_reputation: Optional[float] = None,
        supports: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, str] = {}
        if capability:
            params["capability"] = capability
        if min_reputation is not None:
            params["min_reputation"] = str(min_reputation)
        if supports:
            params["supports"] = supports
        return self._request("GET", f"/v1/agents/search?{urllib.parse.urlencode(params)}")

    def get_reputation(self, agent_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/agents/{urllib.parse.quote(agent_id, safe='')}/reputation")

    def get_receipt(self, receipt_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/receipts/{urllib.parse.quote(receipt_id, safe='')}")

    def list_receipts(self, agent_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/agents/{urllib.parse.quote(agent_id, safe='')}/receipts")

    def submit_work(self, agent_a_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        """Called by the worker (agent_b) once a job is complete, off-network."""
        content = build_signable_content(agent_a_id, self.did, input)
        signing_bytes = canonicalize({**content, "dispute": None}).encode("utf-8")
        signature = to_base64(sign(signing_bytes, self.keypair.private_key))
        body = {**input, "agentAId": agent_a_id, "signature": signature}
        return self._request("POST", "/v1/receipts", body, idempotency_key=f"receipt:{input['jobId']}")

    def accept_work(self, receipt: Dict[str, Any]) -> Dict[str, Any]:
        """Called by the requester (agent_a) to accept the worker's submitted result."""
        content = {**receipt, "signatures": None, "status": None, "dispute": None}
        signing_bytes = canonicalize(content).encode("utf-8")
        signature = to_base64(sign(signing_bytes, self.keypair.private_key))
        receipt_id = urllib.parse.quote(receipt["receiptId"], safe="")
        return self._request(
            "POST",
            f"/v1/receipts/{receipt_id}/countersign",
            {"signature": signature},
            idempotency_key=f"countersign:{receipt['receiptId']}",
        )

    def dispute_receipt(self, receipt_id: str, reason: str) -> Dict[str, Any]:
        encoded = urllib.parse.quote(receipt_id, safe="")
        return self._request(
            "POST",
            f"/v1/receipts/{encoded}/dispute",
            {"reason": reason},
            idempotency_key=f"dispute:{receipt_id}",
        )

    def resolve_dispute(self, receipt_id: str, note: Optional[str] = None) -> Dict[str, Any]:
        """Withdraw a dispute this client opened (SPEC.md section 4.3) -- moves
        the receipt disputed -> finalized so it counts toward reputation
        again. Only the party that opened the dispute may call this, once."""
        encoded = urllib.parse.quote(receipt_id, safe="")
        return self._request(
            "POST",
            f"/v1/receipts/{encoded}/dispute/resolve",
            {"note": note} if note is not None else {},
            idempotency_key=f"dispute-resolve:{receipt_id}",
        )

    # ---- Jobs (SPEC.md section 3) -- optional pre-work discovery/offer/accept ----

    def post_job(
        self,
        capability: str,
        spec_hash: str,
        budget: Optional[Dict[str, Any]] = None,
        expires_at: Optional[str] = None,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"capability": capability, "specHash": spec_hash}
        if budget is not None:
            body["budget"] = budget
        if expires_at is not None:
            body["expiresAt"] = expires_at
        return self._request("POST", "/v1/jobs", body, idempotency_key=f"job:{capability}:{spec_hash}:{time.time()}")

    def get_job(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/jobs/{urllib.parse.quote(job_id, safe='')}")

    def search_jobs(self, capability: Optional[str] = None, status: Optional[str] = None) -> Dict[str, Any]:
        params: Dict[str, str] = {}
        if capability:
            params["capability"] = capability
        if status:
            params["status"] = status
        return self._request("GET", f"/v1/jobs/search?{urllib.parse.urlencode(params)}")

    def submit_offer(self, job_id: str, message: Optional[str] = None) -> Dict[str, Any]:
        encoded = urllib.parse.quote(job_id, safe="")
        body: Dict[str, Any] = {}
        if message is not None:
            body["message"] = message
        return self._request(
            "POST",
            f"/v1/jobs/{encoded}/offers",
            body,
            idempotency_key=f"offer:{job_id}:{self.did}",
        )

    def list_offers(self, job_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/jobs/{urllib.parse.quote(job_id, safe='')}/offers")

    def accept_offer(self, job_id: str, agent_id: str) -> Dict[str, Any]:
        """Called by the job's poster to accept one offer."""
        encoded = urllib.parse.quote(job_id, safe="")
        return self._request(
            "POST",
            f"/v1/jobs/{encoded}/accept",
            {"agentId": agent_id},
            idempotency_key=f"accept:{job_id}:{agent_id}",
        )

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        """Called by the job's poster to cancel a not-yet-completed job."""
        encoded = urllib.parse.quote(job_id, safe="")
        return self._request("POST", f"/v1/jobs/{encoded}/cancel", None, idempotency_key=f"cancel:{job_id}")

    # ---- Verification (SPEC.md section 12) -- independent attestation of a finalized receipt ----

    def submit_verification(
        self,
        receipt_id: str,
        method: str,
        output_hash: str,
        result: str,
        score: Optional[float] = None,
        evidence_uri: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Called by the verifier (who must not be the receipt's own provider/agentB).
        `jobId`/`provider` are derived from the referenced receipt (fetched here)
        rather than taken as caller input -- the server independently derives
        the same values and would reject a signature built over the wrong
        ones, so there's no correct way for a caller to supply them manually.
        """
        receipt = self.get_receipt(receipt_id)
        content_input: Dict[str, Any] = {
            "receiptId": receipt_id,
            "jobId": receipt["jobId"],
            "provider": receipt["agentB"]["id"],
            "verifier": self.did,
            "method": method,
            "outputHash": output_hash,
            "result": result,
        }
        if score is not None:
            content_input["score"] = score
        if evidence_uri is not None:
            content_input["evidenceUri"] = evidence_uri

        content = build_signable_verification_content(content_input)
        signing_bytes = canonicalize(content).encode("utf-8")
        signature = to_base64(sign(signing_bytes, self.keypair.private_key))

        body: Dict[str, Any] = {
            "receiptId": receipt_id,
            "verifier": self.did,
            "method": method,
            "outputHash": output_hash,
            "result": result,
            "signature": signature,
        }
        if score is not None:
            body["score"] = score
        if evidence_uri is not None:
            body["evidenceUri"] = evidence_uri
        return self._request("POST", "/v1/verifications", body, idempotency_key=f"verification:{content['verificationId']}")

    def get_verification(self, verification_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/verifications/{urllib.parse.quote(verification_id, safe='')}")

    def list_receipt_verifications(self, receipt_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/receipts/{urllib.parse.quote(receipt_id, safe='')}/verifications")
