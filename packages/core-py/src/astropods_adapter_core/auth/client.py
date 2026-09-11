from __future__ import annotations

from typing import Any, Optional, Protocol

from .cache import CacheKey
from .types import AuthorizeUnavailableError, Decision


class HttpGet(Protocol):
    def __call__(
        self,
        url: str,
        *,
        params: dict[str, str],
        headers: dict[str, str],
        timeout: float,
    ) -> Any: ...


class AuthorizeClient:
    """Calls astro-server's per-request authorization endpoint, presenting the
    deploy token as a Bearer credential. The server validates the signature and
    resolves the principal on every call."""

    def __init__(
        self,
        server_url: str,
        token: str,
        timeout_seconds: float,
        http_get: Optional[HttpGet] = None,
    ) -> None:
        self._server_url = server_url.rstrip("/")
        self._token = token
        self._timeout = timeout_seconds
        self._http_get = http_get

    def authorize(self, key: CacheKey) -> Decision:
        params = {"adapter": key.adapter}
        if key.identity_type:
            params["identity_type"] = key.identity_type
        if key.identity_id:
            params["identity_id"] = key.identity_id
        if key.identity_scope:
            params["identity_scope"] = key.identity_scope

        try:
            res = self._get()(
                f"{self._server_url}/api/v1/deployments/authorize",
                params=params,
                headers={"authorization": f"Bearer {self._token}"},
                timeout=self._timeout,
            )
        except Exception as err:
            raise AuthorizeUnavailableError(str(err)) from err

        if res.status_code != 200:
            raise AuthorizeUnavailableError(f"authorize returned {res.status_code}")

        try:
            body = res.json()
        except Exception as err:
            raise AuthorizeUnavailableError(f"authorize body: {err}") from err

        return Decision(
            allowed=body.get("allowed") is True,
            user_id=body.get("user_id") or None,
        )

    def _get(self) -> HttpGet:
        if self._http_get is not None:
            return self._http_get
        import httpx

        return httpx.get
