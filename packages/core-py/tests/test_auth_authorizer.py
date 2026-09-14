from __future__ import annotations

import base64
import json
from typing import Any, Optional

import pytest

from astropods_adapter_core.auth import (
    Authorizer,
    AuthorizeUnavailableError,
    Principal,
    guard,
)

SERVER = "https://app.astropods.com"


def deploy_token(anyone_adapters: Optional[list[str]] = None) -> str:
    def encode(obj: dict[str, Any]) -> str:
        raw = base64.urlsafe_b64encode(json.dumps(obj).encode()).decode()
        return raw.rstrip("=")

    return ".".join(
        [
            encode({"alg": "HS256", "typ": "JWT"}),
            encode(
                {
                    "sub": "dep_1",
                    "iss": SERVER,
                    "anyone_adapters": anyone_adapters or [],
                }
            ),
            "signature",
        ]
    )


class StubResponse:
    def __init__(self, body: dict[str, Any], status_code: int = 200) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> dict[str, Any]:
        return self._body


class StubServer:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []
        self._i = 0

    def __call__(
        self,
        url: str,
        *,
        params: dict[str, str],
        headers: dict[str, str],
        timeout: float,
    ) -> Any:
        self.calls.append({"url": url, "params": params, "headers": headers})
        nxt = self.responses[min(self._i, len(self.responses) - 1)]
        self._i += 1
        if isinstance(nxt, Exception):
            raise nxt
        return nxt


def build(
    responses: Optional[list[Any]] = None,
    anyone_adapters: Optional[list[str]] = None,
) -> tuple[Authorizer, StubServer]:
    stub = StubServer(responses or [StubResponse({"allowed": True, "user_id": "user_1"})])
    authz = Authorizer(
        identity_token=deploy_token(anyone_adapters),
        http_get=stub,
        verify_identity=False,
    )
    return authz, stub


PRINCIPAL = Principal(user_id="user_1", source="alb")


def test_identify_reads_the_user_id_the_front_door_injected():
    authz, _ = build()
    p = authz.identify({"x-amzn-oidc-identity": "user_1"})
    assert p is not None and p.user_id == "user_1" and p.source == "alb"


def test_identify_matches_the_identity_header_case_insensitively():
    authz, _ = build()
    p = authz.identify({"X-Amzn-Oidc-Identity": "user_1"})
    assert p is not None and p.user_id == "user_1"


def test_identify_returns_none_when_the_request_carries_no_identity():
    authz, _ = build()
    assert authz.identify({}) is None


def test_identify_returns_the_configured_identity_in_dev_mode():
    authz = Authorizer(identity_token="", dev_user_id="user_dev")
    p = authz.identify({})
    assert p is not None and p.user_id == "user_dev" and p.source == "fixed"


def test_authorize_allows_a_principal_the_server_grants():
    authz, _ = build()
    decision = authz.authorize(PRINCIPAL)
    assert decision.allowed is True and decision.user_id == "user_1"


def test_authorize_denies_a_principal_the_server_rejects():
    authz, _ = build(responses=[StubResponse({"allowed": False})])
    assert authz.authorize(PRINCIPAL).allowed is False


def test_authorize_targets_the_custom_adapter_by_default():
    authz, stub = build()
    authz.authorize(PRINCIPAL)
    params = stub.calls[0]["params"]
    assert params["adapter"] == "custom"
    assert params["identity_type"] == "user"
    assert params["identity_id"] == "user_1"
    assert stub.calls[0]["url"].endswith("/api/v1/deployments/authorize")


def test_authorize_presents_the_deploy_token_as_the_bearer_credential():
    authz, stub = build()
    authz.authorize(PRINCIPAL)
    assert stub.calls[0]["headers"]["authorization"] == f"Bearer {deploy_token()}"


def test_authorize_sends_no_identity_for_an_anonymous_caller():
    authz, stub = build()
    authz.authorize(None)
    assert "identity_type" not in stub.calls[0]["params"]
    assert "identity_id" not in stub.calls[0]["params"]


def test_authorize_serves_a_repeat_check_from_cache():
    authz, stub = build()
    authz.authorize(PRINCIPAL)
    authz.authorize(PRINCIPAL)
    assert len(stub.calls) == 1


def test_authorize_fails_closed_when_the_server_is_unreachable():
    authz, _ = build(responses=[RuntimeError("connection refused")])
    with pytest.raises(AuthorizeUnavailableError):
        authz.authorize(PRINCIPAL)


def test_authorize_does_not_cache_a_transport_failure():
    authz, stub = build(
        responses=[RuntimeError("connection refused"), RuntimeError("connection refused")]
    )
    for _ in range(2):
        with pytest.raises(AuthorizeUnavailableError):
            authz.authorize(PRINCIPAL)
    assert len(stub.calls) == 2


def test_authorize_stays_up_during_an_outage_when_the_adapter_is_open():
    authz, _ = build(
        responses=[RuntimeError("connection refused")], anyone_adapters=["custom"]
    )
    assert authz.authorize(PRINCIPAL).allowed is True


def test_authorize_treats_a_server_error_as_unavailable_not_a_denial():
    authz, _ = build(responses=[StubResponse({}, status_code=500)])
    with pytest.raises(AuthorizeUnavailableError):
        authz.authorize(PRINCIPAL)


def test_authorize_allows_everything_in_dev_mode_without_calling_the_server():
    authz = Authorizer(identity_token="")
    assert authz.dev_mode is True
    assert authz.authorize(None).allowed is True


def test_guard_passes_an_allowed_caller_through_with_their_principal():
    authz, _ = build()
    outcome = guard(authz, {"x-amzn-oidc-identity": "user_1"})
    assert outcome.status == 200
    assert outcome.principal is not None and outcome.principal.user_id == "user_1"


def test_guard_authorizes_a_request_with_no_identity_as_anonymous():
    authz, stub = build()
    outcome = guard(authz, {})
    assert outcome.status == 200, "a public interface has no identity header to offer"
    assert outcome.principal is None
    assert stub.calls[0]["params"] == {"adapter": "custom"}


def test_guard_answers_401_when_an_anonymous_caller_has_no_anyone_grant():
    authz, _ = build(responses=[StubResponse({"allowed": False})])
    assert guard(authz, {}).status == 401


def test_guard_answers_403_when_the_grants_exclude_the_caller():
    authz, _ = build(responses=[StubResponse({"allowed": False})])
    assert guard(authz, {"x-amzn-oidc-identity": "user_1"}).status == 403


def test_guard_answers_503_when_the_authorize_call_cannot_complete():
    authz, _ = build(responses=[RuntimeError("connection refused")])
    assert guard(authz, {"x-amzn-oidc-identity": "user_1"}).status == 503
