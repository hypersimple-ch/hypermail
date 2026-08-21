"""Small RFC 7638 / RFC 9449 profile-key and DPoP implementation."""
from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from typing import Any, Callable


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def public_jwk(private_jwk: dict[str, Any]) -> dict[str, str]:
    if private_jwk.get("kty") != "EC" or private_jwk.get("crv") != "P-256":
        raise ValueError("The Hermes profile key must be an EC P-256 JWK.")
    public = {name: private_jwk.get(name) for name in ("crv", "kty", "x", "y")}
    if not all(isinstance(value, str) and value for value in public.values()):
        raise ValueError("The Hermes profile JWK is missing public coordinates.")
    if not isinstance(private_jwk.get("d"), str) or not private_jwk["d"]:
        raise ValueError("The Hermes profile JWK has no private component.")
    # Reject a private scalar whose derived public point does not match x/y.
    from cryptography.hazmat.primitives.asymmetric import ec
    scalar = int.from_bytes(_decode(private_jwk["d"]), "big")
    key = ec.derive_private_key(scalar, ec.SECP256R1())
    numbers = key.public_key().public_numbers()
    expected_x = _b64(numbers.x.to_bytes(32, "big"))
    expected_y = _b64(numbers.y.to_bytes(32, "big"))
    if public["x"] != expected_x or public["y"] != expected_y:
        raise ValueError("The Hermes profile JWK public coordinates do not match its private key.")
    return public  # type: ignore[return-value]


def jwk_thumbprint(jwk: dict[str, Any]) -> str:
    canonical = json.dumps(public_jwk(jwk), separators=(",", ":"), sort_keys=True).encode()
    return _b64(hashlib.sha256(canonical).digest())


def dpop_proof(
    private_jwk: dict[str, Any], method: str, url: str, *, access_token: str | None = None,
    nonce: str | None = None, now: Callable[[], float] = time.time, jti: str | None = None,
) -> str:
    """Create an ES256 DPoP proof. The public profile key is the proof key."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    public = public_jwk(private_jwk)
    header = {"alg": "ES256", "typ": "dpop+jwt", "jwk": public}
    payload: dict[str, Any] = {
        "htm": method.upper(), "htu": url, "iat": int(now()), "jti": jti or str(uuid.uuid4()),
    }
    if access_token is not None:
        payload["ath"] = _b64(hashlib.sha256(access_token.encode()).digest())
    if nonce:
        payload["nonce"] = nonce
    encoded_header = _b64(json.dumps(header, separators=(",", ":"), sort_keys=True).encode())
    encoded_payload = _b64(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    signing_input = f"{encoded_header}.{encoded_payload}".encode()
    scalar = int.from_bytes(_decode(private_jwk["d"]), "big")
    key = ec.derive_private_key(scalar, ec.SECP256R1())
    der = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return f"{encoded_header}.{encoded_payload}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"
