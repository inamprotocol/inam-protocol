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
from typing import Any, Dict, List, Optional

from .canonical import canonicalize
from .keys import Keypair, sha256_hex, sign, to_base64
from .receipt import build_signable_content


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
            "user-agent": "inamprotocol-python-sdk/0.1.0",
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
        return self._request(
            "POST",
            "/v1/agents",
            {"capabilities": capabilities, "metadata": metadata},
            idempotency_key=f"register:{self.keypair.did}",
        )

    def get_agent(self, agent_id: str) -> Dict[str, Any]:
        return self._request("GET", f"/v1/agents/{urllib.parse.quote(agent_id, safe='')}")

    def link_identity(self, protocol: str, value: str) -> Dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(self.did, safe='')}/link",
            {"protocol": protocol, "value": value},
            idempotency_key=f"link:{protocol}:{value}",
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
