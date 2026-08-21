"""Client for Hypermail's public external durable-task HTTP contract.

This module deliberately knows nothing about Hypermail's task store, queue, or
migrations. It consumes only the OAuth and connector HTTP contracts.
"""
from __future__ import annotations

import json
import hashlib
import ssl
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from .security import dpop_proof, jwk_thumbprint


class ConnectorError(RuntimeError):
    pass


@dataclass(frozen=True)
class Response:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


class Requester(Protocol):
    def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> Response: ...


class UrlLibRequester:
    def __init__(self, ssl_context: ssl.SSLContext | None = None):
        self._context = ssl_context or ssl.create_default_context()

    def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> Response:
        request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=self._context) as result:
                return Response(result.status, dict(result.headers.items()), result.read())
        except urllib.error.HTTPError as error:
            return Response(error.code, dict(error.headers.items()), error.read())


@dataclass(frozen=True)
class Claim:
    task_id: str
    run_id: str
    generation: int
    lease_token: str
    envelope: dict[str, Any]


class HypermailConnectorClient:
    """OAuth/DPoP-bound client. Access tokens are never persisted by the plugin."""
    def __init__(self, *, base_url: str, token_endpoint: str, client_id: str, refresh_token: str,
                 connection_id: str, profile_id: str, private_jwk: dict[str, Any],
                 requester: Requester | None = None):
        self.base_url = base_url.rstrip("/")
        self.token_endpoint = token_endpoint
        self.client_id = client_id
        self.refresh_token = refresh_token
        self.connection_id = connection_id
        self.profile_id = profile_id
        self.private_jwk = private_jwk
        self.requester = requester or UrlLibRequester()
        self._access_token: str | None = None
        self._token_type: str | None = None
        for value, label in ((self.base_url, "agent URL"), (self.token_endpoint, "OAuth token endpoint")):
            parsed = urllib.parse.urlsplit(value)
            if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError(f"Hypermail {label} must be an HTTPS URL without userinfo.")
        if not all((client_id, refresh_token, connection_id, profile_id)):
            raise ValueError("Hypermail pairing and OAuth configuration is incomplete.")
        jwk_thumbprint(private_jwk)  # validates private/public consistency immediately

    @property
    def profile_key_thumbprint(self) -> str:
        return jwk_thumbprint(self.private_jwk)

    @staticmethod
    def _header(headers: Mapping[str, str], name: str) -> str | None:
        return next((value for key, value in headers.items() if key.lower() == name.lower()), None)

    def _token(self) -> str:
        if self._access_token:
            return self._access_token
        form = urllib.parse.urlencode({
            "grant_type": "refresh_token", "client_id": self.client_id,
            "refresh_token": self.refresh_token,
        }).encode()
        nonce: str | None = None
        for attempt in range(2):
            proof = dpop_proof(self.private_jwk, "POST", self.token_endpoint, nonce=nonce)
            response = self.requester.request("POST", self.token_endpoint, {
                "Content-Type": "application/x-www-form-urlencoded", "DPoP": proof,
            }, form, 30)
            next_nonce = self._header(response.headers, "DPoP-Nonce")
            if response.status in (400, 401) and next_nonce and attempt == 0:
                nonce = next_nonce
                continue
            if response.status != 200:
                raise ConnectorError(f"OAuth token request failed ({response.status}).")
            payload = response.json()
            token = payload.get("access_token") if isinstance(payload, dict) else None
            token_type = str(payload.get("token_type", "")) if isinstance(payload, dict) else ""
            if not isinstance(token, str) or not token or token_type.lower() != "dpop":
                raise ConnectorError("OAuth server did not issue a DPoP-bound access token.")
            self._access_token, self._token_type = token, token_type
            return token
        raise ConnectorError("OAuth DPoP nonce challenge failed.")

    def _api(self, method: str, path: str, payload: Any = None, *, timeout: float = 30) -> Response:
        url = self.base_url + path
        token = self._token()
        body = None if payload is None else json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
        nonce: str | None = None
        for attempt in range(2):
            proof = dpop_proof(self.private_jwk, method, url, access_token=token, nonce=nonce)
            headers = {"Authorization": f"DPoP {token}", "DPoP": proof, "Accept": "application/json"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            response = self.requester.request(method, url, headers, body, timeout)
            next_nonce = self._header(response.headers, "DPoP-Nonce")
            if response.status in (400, 401) and next_nonce and attempt == 0:
                nonce = next_nonce
                continue
            if response.status == 401 and attempt == 0:
                self._access_token = None
                token = self._token()
                continue
            return response
        return response

    def verify_pairing(self) -> None:
        """Fail closed unless the server confirms this profile/key/connection tuple."""
        response = self._api("POST", "/v1/agent-connector/pairing/verify", {
            "connectionId": self.connection_id,
            "externalProfileId": self.profile_id,
            "profileKeyThumbprint": self.profile_key_thumbprint,
        })
        if response.status != 200:
            raise ConnectorError(f"Pairing verification failed ({response.status}).")
        value = response.json()
        expected = {
            "verified": True, "connectionId": self.connection_id,
            "externalProfileId": self.profile_id, "profileKeyThumbprint": self.profile_key_thumbprint,
        }
        if not isinstance(value, dict) or any(value.get(k) != v for k, v in expected.items()):
            raise ConnectorError("Pairing response does not bind the configured Hermes profile key.")

    def claim(self, wait_seconds: int = 25) -> Claim | None:
        wait = max(1, min(wait_seconds, 30))
        response = self._api("POST", f"/v1/agent-connector/tasks:claim?wait={wait}", {
            "connectionId": self.connection_id,
        }, timeout=wait + 10)
        if response.status == 204:
            return None
        if response.status != 200:
            raise ConnectorError(f"Task long-poll failed ({response.status}).")
        value = response.json()
        task = value.get("task") if isinstance(value, dict) else None
        if not isinstance(task, dict):
            raise ConnectorError("Malformed task claim.")
        task_id, run_id, lease_token = task.get("id"), value.get("runId"), value.get("leaseToken")
        generation = task.get("leaseGeneration")
        if not isinstance(task_id, str) or not isinstance(run_id, str) or not isinstance(lease_token, str) or not isinstance(generation, int) or generation < 1:
            raise ConnectorError("Malformed task claim fencing data.")
        return Claim(task_id, run_id, generation, lease_token, value)

    def _report(self, claim: Claim, operation: str, extra: dict[str, Any]) -> None:
        request_id = f"hermes-{operation}:{uuid.uuid4()}"
        body = {"connectionId": self.connection_id, "taskId": claim.task_id,
                "generation": claim.generation, "leaseToken": claim.lease_token,
                "requestId": request_id, **extra}
        # The public durable protocol requires an idempotency digest alongside
        # its request ID. Digest the canonical command before adding the digest.
        body["requestDigest"] = hashlib.sha256(
            json.dumps(body, separators=(",", ":"), sort_keys=True).encode()
        ).hexdigest()
        response = self._api("POST", f"/v1/agent-connector/tasks/{claim.task_id}:{operation}", body)
        if response.status not in (200, 204):
            raise ConnectorError(f"Task {operation} failed ({response.status}).")

    def heartbeat(self, claim: Claim) -> None:
        self._report(claim, "heartbeat", {})

    def complete(self, claim: Claim, result: dict[str, Any]) -> None:
        self._report(claim, "complete", {"result": result})

    def fail(self, claim: Claim, error_code: str) -> None:
        self._report(claim, "fail", {"errorCode": error_code})
