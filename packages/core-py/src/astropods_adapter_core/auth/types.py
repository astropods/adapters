from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Optional

IdentitySource = Literal["alb", "fixed"]


@dataclass
class Principal:
    """Who the caller is, once an identity source has produced one."""

    user_id: str
    source: IdentitySource
    email: Optional[str] = None
    name: Optional[str] = None
    claims: dict[str, Any] = field(default_factory=dict)


@dataclass
class Decision:
    """The server's answer to "may this principal use this deployment?"."""

    allowed: bool
    # Canonical WorkOS user id, populated by the server only when allowed.
    user_id: Optional[str] = None


class AuthorizeUnavailableError(Exception):
    """The authorize call could not complete. Callers fail closed."""


class IdentityTokenError(Exception):
    """ASTRO_AUTHZ_TOKEN is present but unusable."""


def normalize_headers(headers: Mapping[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in headers.items():
        name = key.decode() if isinstance(key, bytes) else str(key)
        if isinstance(value, bytes):
            value = value.decode()
        elif isinstance(value, (list, tuple)):
            value = value[0] if value else ""
        if value is None:
            continue
        out[name.lower()] = str(value)
    return out
