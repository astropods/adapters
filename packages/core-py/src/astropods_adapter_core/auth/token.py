from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field

from .types import IdentityTokenError


@dataclass
class DeployTokenClaims:
    # Deployment id.
    subject: str
    # astro-server's base URL.
    issuer: str
    anyone_adapters: list[str] = field(default_factory=list)


def decode_deploy_token(raw: str) -> DeployTokenClaims:
    """Decode ASTRO_AUTHZ_TOKEN without verifying its signature.

    The container has no access to the signing secret; the authorize endpoint
    is the authority on every call.
    """
    if not raw:
        raise IdentityTokenError("identity token is empty")

    parts = raw.split(".")
    if len(parts) != 3:
        raise IdentityTokenError(
            f"identity token: expected 3 segments, got {len(parts)}"
        )

    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
    except Exception as err:
        raise IdentityTokenError(f"identity token payload: {err}") from err

    if not isinstance(payload, dict):
        raise IdentityTokenError("identity token payload is not an object")

    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject:
        raise IdentityTokenError("identity token missing sub claim (deployment id)")

    issuer = payload.get("iss")
    if not isinstance(issuer, str) or not issuer:
        raise IdentityTokenError("identity token missing iss claim (server URL)")

    adapters = payload.get("anyone_adapters")

    return DeployTokenClaims(
        subject=subject,
        issuer=issuer,
        anyone_adapters=[a for a in adapters if isinstance(a, str)]
        if isinstance(adapters, list)
        else [],
    )
