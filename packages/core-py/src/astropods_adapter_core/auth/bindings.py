from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Iterable

from .authorizer import Authorizer
from .guard import guard, guard_async

# Frameworks are typed structurally so this package depends on none of them.

_SCOPE_KEY = "astro_principal"


class AstroAuthMiddleware:
    """ASGI middleware. Covers FastAPI, Starlette, and anything else ASGI.

    On success the principal is placed at ``scope["astro_principal"]``, which
    Starlette surfaces as ``request.scope["astro_principal"]``.
    """

    def __init__(self, app: Any, authorizer: Authorizer | None = None) -> None:
        self.app = app
        self.authz = authorizer or Authorizer()

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode(): v.decode() for k, v in scope.get("headers", [])}
        outcome = await guard_async(self.authz, headers)
        if outcome.status != 200:
            await _send_json(send, outcome.status, {"error": outcome.message})
            return

        scope[_SCOPE_KEY] = outcome.principal
        await self.app(scope, receive, send)


def fastapi_dependency(authorizer: Authorizer | None = None):
    """FastAPI dependency that authorizes the request and returns the principal.

    Use when you want the check on selected routes rather than app-wide.
    """
    authz = authorizer or Authorizer()

    async def dependency(request: Any) -> Any:
        from fastapi import HTTPException

        outcome = await guard_async(authz, dict(request.headers))
        if outcome.status != 200:
            raise HTTPException(status_code=outcome.status, detail=outcome.message)
        return outcome.principal

    return dependency


class WsgiAuthMiddleware:
    """WSGI middleware. Covers Flask, Django, and anything else WSGI.

    On success the principal is placed in the WSGI environ under
    ``astro.principal``.
    """

    def __init__(self, app: Any, authorizer: Authorizer | None = None) -> None:
        self.app = app
        self.authz = authorizer or Authorizer()

    def __call__(
        self,
        environ: dict[str, Any],
        start_response: Callable[..., Any],
    ) -> Iterable[bytes]:
        outcome = guard(self.authz, _headers_from_environ(environ))
        if outcome.status != 200:
            body = json.dumps({"error": outcome.message}).encode()
            start_response(
                f"{outcome.status} {_REASONS[outcome.status]}",
                [
                    ("content-type", "application/json"),
                    ("content-length", str(len(body))),
                ],
            )
            return [body]

        environ["astro.principal"] = outcome.principal
        return self.app(environ, start_response)


_REASONS = {
    401: "Unauthorized",
    403: "Forbidden",
    503: "Service Unavailable",
}


def _headers_from_environ(environ: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            out[key[5:].replace("_", "-").lower()] = value
    return out


async def _send_json(
    send: Callable[[dict[str, Any]], Awaitable[None]],
    status: int,
    body: dict[str, Any],
) -> None:
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
