from __future__ import annotations

import logging
import os
from typing import Any, Mapping, Optional

from .alb import DATA_HEADER, IDENTITY_HEADER, AlbIdentityVerifier
from .cache import CacheKey, DecisionCache
from .client import AuthorizeClient, HttpGet
from .token import decode_deploy_token
from .types import Decision, Principal, normalize_headers

DEFAULT_ADAPTER = "custom"
DEFAULT_CACHE_TTL_SECONDS = 60.0
DEFAULT_TIMEOUT_SECONDS = 5.0
DEGRADED_CACHE_TTL_SECONDS = 10.0

_IDENTITY_TYPE_USER = "user"

logger = logging.getLogger("astropods.auth")


class Authorizer:
    """Answers "who is calling, and may they use this deployment?" for an agent
    serving its own HTTP surface."""

    def __init__(
        self,
        identity_token: Optional[str] = None,
        adapter: Optional[str] = None,
        cache_ttl_seconds: Optional[float] = None,
        timeout_seconds: Optional[float] = None,
        verify_identity: bool = True,
        region: Optional[str] = None,
        dev_user_id: Optional[str] = None,
        http_get: Optional[HttpGet] = None,
    ) -> None:
        token = (
            identity_token
            if identity_token is not None
            else os.environ.get("ASTRO_AUTHZ_TOKEN", "")
        )
        self.adapter = adapter or os.environ.get("ASTRO_AUTH_ADAPTER") or DEFAULT_ADAPTER
        self._dev_user_id = dev_user_id or os.environ.get("ASTRO_AUTH_DEV_USER_ID")
        self._cache = DecisionCache(
            _seconds(cache_ttl_seconds, "ASTRO_AUTH_CACHE_TTL", DEFAULT_CACHE_TTL_SECONDS)
        )
        self._verifier: Optional[AlbIdentityVerifier] = None
        self._client: Optional[AuthorizeClient] = None

        if not token:
            self.deployment_id = ""
            self.anyone_adapters: list[str] = []
            logger.warning(
                "auth: authorization disabled, ASTRO_AUTHZ_TOKEN not set "
                "(dev mode, all requests allowed)"
            )
            return

        claims = decode_deploy_token(token)
        self.deployment_id = claims.subject
        self.anyone_adapters = claims.anyone_adapters
        self._client = AuthorizeClient(
            claims.issuer,
            token,
            _seconds(timeout_seconds, "ASTRO_AUTH_TIMEOUT", DEFAULT_TIMEOUT_SECONDS),
            http_get,
        )

        if verify_identity:
            self._verifier = AlbIdentityVerifier(
                region=region or os.environ.get("AWS_REGION")
            )
        else:
            logger.warning(
                "auth: x-amzn-oidc-data signature verification disabled by configuration"
            )

        logger.info(
            "auth: authorizer initialized",
            extra={
                "deployment_id": self.deployment_id,
                "server_url": claims.issuer,
                "adapter": self.adapter,
                "anyone_adapters": self.anyone_adapters,
            },
        )

    @property
    def dev_mode(self) -> bool:
        """True when no deploy token was supplied, so every request is allowed."""
        return self._client is None

    def identify(self, headers: Mapping[str, Any]) -> Optional[Principal]:
        """Resolve the caller from the front door's identity headers. Returns
        None when no identity is present, or a present one fails verification."""
        if self.dev_mode:
            if self._dev_user_id:
                return Principal(user_id=self._dev_user_id, source="fixed")
            return None

        h = normalize_headers(headers)

        data = h.get(DATA_HEADER)
        if data and self._verifier is not None:
            try:
                return self._verifier.verify(data)
            except Exception as err:
                logger.warning("auth: identity header verification failed: %s", err)
                return None

        identity = h.get(IDENTITY_HEADER)
        if not identity:
            return None
        return Principal(user_id=identity, source="alb")

    def authorize(self, principal: Optional[Principal]) -> Decision:
        """Check the principal against the deployment's grants. A None principal
        is sent as an anonymous request, which the server allows only under an
        ``anyone`` grant."""
        if self._client is None:
            return Decision(
                allowed=True, user_id=principal.user_id if principal else None
            )

        key = CacheKey(
            identity_type=_IDENTITY_TYPE_USER if principal else "",
            identity_id=principal.user_id if principal else "",
            adapter=self.adapter,
            identity_scope="",
        )

        cached = self._cache.get(key)
        if cached is not None:
            return cached

        try:
            decision = self._client.authorize(key)
        except Exception as err:
            if self.adapter in self.anyone_adapters:
                logger.warning(
                    "auth: authorize call failed, serving via anyone-adapters "
                    "token claim: %s",
                    err,
                )
                degraded = Decision(allowed=True)
                self._cache.set(key, degraded, DEGRADED_CACHE_TTL_SECONDS)
                return degraded
            logger.warning("auth: authorize call failed: %s", err)
            raise

        self._cache.set(key, decision)
        if not decision.allowed:
            logger.warning("auth: authorize denied", extra={"adapter": self.adapter})
        return decision


def _seconds(explicit: Optional[float], env_name: str, fallback: float) -> float:
    if explicit is not None and explicit > 0:
        return explicit
    try:
        value = float(os.environ.get(env_name, ""))
    except ValueError:
        return fallback
    return value if value > 0 else fallback
