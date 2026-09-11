from __future__ import annotations

import threading
import time
from typing import Any, Callable, Optional

from .types import Principal

IDENTITY_HEADER = "x-amzn-oidc-identity"
DATA_HEADER = "x-amzn-oidc-data"
ACCESS_TOKEN_HEADER = "x-amzn-oidc-accesstoken"


def region_from_signer_arn(arn: Optional[str]) -> Optional[str]:
    if not arn:
        return None
    parts = arn.split(":")
    return parts[3] if len(parts) > 3 and parts[3] else None


class AlbIdentityVerifier:
    """Verifies the signed claims JWT the ALB injects on authenticated requests.

    ALB puts ``exp`` in the JWT *header*, not the payload, and the payload holds
    only the IdP's user claims. Expiry is therefore checked against the header.
    """

    def __init__(
        self,
        region: Optional[str] = None,
        fetch_key: Optional[Callable[[str, str], str]] = None,
    ) -> None:
        self._region = region
        self._fetch_key = fetch_key or _fetch_alb_public_key
        self._keys: dict[str, Any] = {}
        self._lock = threading.Lock()

    def verify(self, data: str) -> Principal:
        import jwt

        header = jwt.get_unverified_header(data)

        if header.get("alg") != "ES256":
            raise ValueError(f"alb identity: unexpected alg {header.get('alg')}")

        kid = header.get("kid")
        if not kid:
            raise ValueError("alb identity: header missing kid")

        exp = header.get("exp")
        if isinstance(exp, (int, float)) and exp <= time.time():
            raise ValueError("alb identity: token expired")

        region = self._region or region_from_signer_arn(header.get("signer"))
        if not region:
            raise ValueError("alb identity: cannot determine region for key lookup")

        claims = jwt.decode(
            data,
            self._key_for(kid, region),
            algorithms=["ES256"],
            options={"verify_exp": False, "verify_aud": False},
        )

        user_id = claims.get("sub")
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("alb identity: payload missing sub")

        email = claims.get("email")
        name = claims.get("name")
        return Principal(
            user_id=user_id,
            source="alb",
            email=email if isinstance(email, str) else None,
            name=name if isinstance(name, str) else None,
            claims=claims,
        )

    def _key_for(self, kid: str, region: str) -> Any:
        with self._lock:
            cached = self._keys.get(kid)
        if cached is not None:
            return cached

        from cryptography.hazmat.primitives.serialization import load_pem_public_key

        key = load_pem_public_key(self._fetch_key(kid, region).encode())
        with self._lock:
            self._keys[kid] = key
        return key


def _fetch_alb_public_key(kid: str, region: str) -> str:
    import urllib.parse

    import httpx

    url = (
        f"https://public-keys.auth.elb.{region}.amazonaws.com/"
        f"{urllib.parse.quote(kid, safe='')}"
    )
    res = httpx.get(url, timeout=5.0)
    if res.status_code != 200:
        raise ValueError(f"alb identity: key fetch returned {res.status_code}")
    return res.text
