from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import unittest
from pathlib import Path
from typing import Mapping

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from hermes_hypermail.client import Claim, HypermailConnectorClient, Response
from hermes_hypermail.security import dpop_proof, jwk_thumbprint
from hermes_hypermail.tools import TaskRuntime, add_runtime, remove_runtime, task_actions, task_no_action, task_question


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def key_jwk() -> dict[str, str]:
    key = ec.generate_private_key(ec.SECP256R1())
    private = key.private_numbers()
    return {"kty": "EC", "crv": "P-256", "x": b64(private.public_numbers.x.to_bytes(32, "big")),
            "y": b64(private.public_numbers.y.to_bytes(32, "big")), "d": b64(private.private_value.to_bytes(32, "big"))}


def verify(proof: str, *, method: str, url: str, token: str | None = None, nonce: str | None = None) -> dict:
    encoded_header, encoded_payload, encoded_signature = proof.split(".")
    header, payload = json.loads(unb64(encoded_header)), json.loads(unb64(encoded_payload))
    self_public = header["jwk"]
    public = ec.EllipticCurvePublicNumbers(int.from_bytes(unb64(self_public["x"]), "big"), int.from_bytes(unb64(self_public["y"]), "big"), ec.SECP256R1()).public_key()
    raw = unb64(encoded_signature)
    public.verify(encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
                  f"{encoded_header}.{encoded_payload}".encode(), ec.ECDSA(hashes.SHA256()))
    assert header["typ"] == "dpop+jwt" and header["alg"] == "ES256"
    assert payload["htm"] == method and payload["htu"] == url
    if token is not None:
        assert payload["ath"] == b64(hashlib.sha256(token.encode()).digest())
    if nonce is not None:
        assert payload["nonce"] == nonce
    return payload


class FakeSecurityServer:
    def __init__(self, jwk: dict[str, str], mismatched_pairing: bool = False):
        self.jwk, self.mismatched_pairing = jwk, mismatched_pairing
        self.token_nonce_issued = False
        self.jtis: set[str] = set()
        self.reports: list[dict] = []

    def request(self, method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float) -> Response:
        del timeout
        proof = headers["DPoP"]
        if url == "https://auth.example.test/oauth/token":
            if not self.token_nonce_issued:
                self.token_nonce_issued = True
                return Response(400, {"DPoP-Nonce": "token-nonce"}, b'{}')
            payload = verify(proof, method="POST", url=url, nonce="token-nonce")
            self._unique(payload["jti"])
            form = (body or b"").decode()
            self.assert_secret_not_in_headers(headers)
            assert "grant_type=refresh_token" in form and "refresh_token=refresh-secret" in form
            return Response(200, {}, json.dumps({"access_token": "access-secret", "token_type": "DPoP"}).encode())
        payload = verify(proof, method=method, url=url, token="access-secret")
        self._unique(payload["jti"])
        assert headers["Authorization"] == "DPoP access-secret"
        data = json.loads(body) if body else None
        if url.endswith("/pairing/verify"):
            result = {"verified": True, "connectionId": "connection-1", "externalProfileId": "profile-1",
                      "profileKeyThumbprint": "wrong" if self.mismatched_pairing else jwk_thumbprint(self.jwk)}
            return Response(200, {}, json.dumps(result).encode())
        if ":complete" in url:
            self.reports.append(data)
            return Response(204, {}, b"")
        return Response(204, {}, b"")

    def _unique(self, jti: str) -> None:
        assert jti not in self.jtis, "DPoP proof replayed"
        self.jtis.add(jti)

    @staticmethod
    def assert_secret_not_in_headers(headers: Mapping[str, str]) -> None:
        assert all("refresh-secret" not in value for value in headers.values())


class SecurityTests(unittest.TestCase):
    def client(self, fake: FakeSecurityServer) -> HypermailConnectorClient:
        return HypermailConnectorClient(base_url="https://mail.example.test", token_endpoint="https://auth.example.test/oauth/token",
            client_id="public-client", refresh_token="refresh-secret", connection_id="connection-1", profile_id="profile-1",
            private_jwk=fake.jwk, requester=fake)

    def test_fake_server_requires_signed_nonce_dpop_and_verifies_pairing_key(self):
        fake = FakeSecurityServer(key_jwk())
        client = self.client(fake)
        client.verify_pairing()
        self.assertGreaterEqual(len(fake.jtis), 2)

    def test_pairing_fails_closed_on_profile_key_mismatch(self):
        fake = FakeSecurityServer(key_jwk(), mismatched_pairing=True)
        with self.assertRaisesRegex(RuntimeError, "does not bind"):
            self.client(fake).verify_pairing()

    def test_rejects_non_https_and_mismatched_private_public_key(self):
        fake = FakeSecurityServer(key_jwk())
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            HypermailConnectorClient(base_url="http://mail.example.test", token_endpoint="https://auth.example.test/oauth/token",
                client_id="c", refresh_token="r", connection_id="x", profile_id="p", private_jwk=fake.jwk, requester=fake)
        tampered = dict(fake.jwk); tampered["x"] = b64(b"\x00" * 32)
        with self.assertRaisesRegex(ValueError, "do not match"):
            dpop_proof(tampered, "GET", "https://mail.example.test")

    def test_only_explicit_structured_tool_reports_completion(self):
        fake = FakeSecurityServer(key_jwk())
        client = self.client(fake); client.verify_pairing()
        runtime = TaskRuntime(client); add_runtime(runtime)
        try:
            claim = Claim("task-1", "run-1", 1, "lease-secret", {"task": {"id": "task-1"}})
            runtime.activate(claim)
            # No API report is produced merely because arbitrary assistant prose exists.
            prose = "I am done; final answer: completed"
            self.assertTrue(prose)
            self.assertEqual(fake.reports, [])
            task_actions({"task_id": "task-1", "action_ids": ["action-1"]})
            self.assertEqual(fake.reports[0]["result"], {"kind": "action_requests_emitted", "actionIds": ["action-1"]})
            digest_body = dict(fake.reports[0]); digest = digest_body.pop("requestDigest")
            self.assertEqual(digest, hashlib.sha256(json.dumps(digest_body, separators=(",", ":"), sort_keys=True).encode()).hexdigest())
        finally:
            remove_runtime(runtime)


@unittest.skipUnless(os.getenv("HYPERMAIL_HERMES_LIVE_ACCEPTANCE") == "1", "set explicit live acceptance gate")
class LiveAcceptanceTests(unittest.TestCase):
    def test_verified_live_pairing(self):
        required = ["HYPERMAIL_AGENT_URL", "HYPERMAIL_OAUTH_TOKEN_ENDPOINT", "HYPERMAIL_OAUTH_CLIENT_ID",
                    "HYPERMAIL_OAUTH_REFRESH_TOKEN", "HYPERMAIL_AGENT_CONNECTION_ID", "HYPERMAIL_HERMES_PROFILE_ID",
                    "HYPERMAIL_PROFILE_PRIVATE_JWK"]
        missing = [name for name in required if not os.getenv(name)]
        self.assertEqual(missing, [], f"live gate enabled but missing: {missing}")
        client = HypermailConnectorClient(base_url=os.environ[required[0]], token_endpoint=os.environ[required[1]],
            client_id=os.environ[required[2]], refresh_token=os.environ[required[3]], connection_id=os.environ[required[4]],
            profile_id=os.environ[required[5]], private_jwk=json.loads(os.environ[required[6]]))
        client.verify_pairing()


if __name__ == "__main__":
    unittest.main()
