from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from .authorizer import Authorizer
from .types import AuthorizeUnavailableError, Principal


@dataclass
class GuardOutcome:
    status: int
    principal: Optional[Principal] = None
    message: str = ""


def guard(authz: Authorizer, headers: Mapping[str, Any]) -> GuardOutcome:
    """The identify-then-authorize sequence every binding runs, with the outcome
    already mapped onto the status code that binding returns.

    An absent identity is authorized as anonymous, not refused here: the
    server's ``anyone`` short-circuit is what admits a public interface.
    """
    principal = authz.identify(headers)

    try:
        decision = authz.authorize(principal)
    except AuthorizeUnavailableError:
        return GuardOutcome(status=503, message="Authorization unavailable")

    if not decision.allowed:
        if principal is None:
            return GuardOutcome(status=401, message="Unauthorized")
        return GuardOutcome(status=403, message="Forbidden")
    return GuardOutcome(status=200, principal=principal)


async def guard_async(authz: Authorizer, headers: Mapping[str, Any]) -> GuardOutcome:
    """``guard`` off the event loop. Only a cache miss reaches the network, so
    most calls never leave the thread pool's fast path."""
    return await asyncio.to_thread(guard, authz, headers)
