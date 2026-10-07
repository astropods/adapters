from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Optional

from .auth.token import decode_deploy_token

DEFAULT_TIMEOUT_SECONDS = 15.0
REFRESH_MARGIN_SECONDS = 60.0
logger = logging.getLogger("astropods.connections")

KNOWN_CODES = frozenset({"not_consented", "not_active", "not_connected", "needs_reauthorization"})

HttpPost = Callable[..., Any]
AsyncHttpPost = Callable[..., Awaitable[Any]]


@dataclass
class ConnectionToken:
    access_token: str
    expires_at: Optional[str] = None
    scopes: list[str] = field(default_factory=list)


class ConnectionTokenError(Exception):
    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class ConnectionClient:
    def __init__(
        self,
        identity_token: Optional[str] = None,
        server_url: Optional[str] = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        http_post: Optional[HttpPost] = None,
        async_http_post: Optional[AsyncHttpPost] = None,
    ) -> None:
        self._token = identity_token if identity_token is not None else os.environ.get("ASTRO_AUTHZ_TOKEN", "")
        claims = decode_deploy_token(self._token)
        self._server_url = (server_url or claims.issuer).rstrip("/")
        self._timeout = timeout_seconds
        self._http_post = http_post
        self._async_http_post = async_http_post
        self._cache: dict[tuple[str, str], ConnectionToken] = {}

    def get_token(self, provider: str, user_id: str) -> ConnectionToken:
        key = self._check(provider, user_id)
        cached = self._cached(key)
        if cached is not None:
            return cached
        try:
            res = self._post()(self._url(), **self._request(provider, user_id))
        except Exception as err:
            logger.warning("connections: token request failed", extra={"provider": provider, "user_id": user_id, "error": str(err)})
            raise ConnectionTokenError("unavailable", 0, f"connection token request failed: {err}") from err
        return self._store(key, provider, res)

    async def get_token_async(self, provider: str, user_id: str) -> ConnectionToken:
        key = self._check(provider, user_id)
        cached = self._cached(key)
        if cached is not None:
            return cached
        try:
            res = await self._async_post()(self._url(), **self._request(provider, user_id))
        except Exception as err:
            logger.warning("connections: token request failed", extra={"provider": provider, "user_id": user_id, "error": str(err)})
            raise ConnectionTokenError("unavailable", 0, f"connection token request failed: {err}") from err
        return self._store(key, provider, res)

    def _check(self, provider: str, user_id: str) -> tuple[str, str]:
        if not user_id:
            logger.warning("connections: token refused, no user for this turn", extra={"provider": provider})
            raise ConnectionTokenError("not_consented", 0, "no user for this turn")
        return (user_id, provider)

    def _cached(self, key: tuple[str, str]) -> Optional[ConnectionToken]:
        token = self._cache.get(key)
        if token is not None and _is_fresh(token):
            logger.debug("connections: token reused from cache", extra={"provider": key[1], "user_id": key[0]})
            return token
        self._cache.pop(key, None)
        return None

    def _url(self) -> str:
        return f"{self._server_url}/api/v1/deployments/connections/token"

    def _request(self, provider: str, user_id: str) -> dict[str, Any]:
        return {
            "json": {"user_id": user_id, "provider": provider},
            "headers": {"authorization": f"Bearer {self._token}"},
            "timeout": self._timeout,
        }

    def _store(self, key: tuple[str, str], provider: str, res: Any) -> ConnectionToken:
        if res.status_code != 200:
            code = _error_code(res)
            logger.warning(
                "connections: token refused",
                extra={"provider": provider, "user_id": key[0], "status": res.status_code, "code": code},
            )
            raise ConnectionTokenError(
                code if code in KNOWN_CODES else "unavailable",
                res.status_code,
                f"{provider} connection token refused: {code or res.status_code}",
            )
        body = res.json()
        token = ConnectionToken(
            access_token=body.get("access_token") or "",
            expires_at=body.get("expires_at") or None,
            scopes=list(body.get("scopes") or []),
        )
        self._cache[key] = token
        logger.info(
            "connections: token issued",
            extra={"provider": provider, "user_id": key[0], "scopes": token.scopes, "expires_at": token.expires_at},
        )
        return token

    def _post(self) -> HttpPost:
        if self._http_post is not None:
            return self._http_post
        import httpx

        return httpx.post

    def _async_post(self) -> AsyncHttpPost:
        if self._async_http_post is not None:
            return self._async_http_post
        import httpx

        async def post(url: str, **kwargs: Any) -> Any:
            async with httpx.AsyncClient() as client:
                return await client.post(url, **kwargs)

        return post


def _is_fresh(token: ConnectionToken) -> bool:
    if not token.expires_at:
        return False
    try:
        expires = datetime.fromisoformat(token.expires_at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    return expires - REFRESH_MARGIN_SECONDS > time.time()


def _error_code(res: Any) -> Optional[str]:
    try:
        body = res.json()
    except Exception:
        return None
    code = body.get("error") if isinstance(body, dict) else None
    return code if isinstance(code, str) else None
