"""Drives the same fixture file as packages/core/src/auth/parity.test.ts.

A behavior change in one language fails here until the other follows.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest

from astropods_adapter_core.auth import Authorizer, Principal, decode_deploy_token, guard

FIXTURE = json.loads(
    (Path(__file__).parents[3] / "test-data" / "auth-parity.json").read_text()
)


class StubResponse:
    def __init__(self, body: dict[str, Any], status_code: int = 200) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> dict[str, Any]:
        return self._body


def server_stub(server: Any):
    calls: list[dict[str, str]] = []

    def http_get(url: str, *, params: dict[str, str], headers: Any, timeout: float):
        calls.append(params)
        if server == "error":
            raise RuntimeError("connection refused")
        if server == "status500":
            return StubResponse({}, status_code=500)
        return StubResponse(server)

    return calls, http_get


def token_for(anyone_adapters: list[str]) -> str:
    def encode(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return ".".join(
        [
            encode({"alg": "HS256", "typ": "JWT"}),
            encode(
                {
                    "sub": "dep_1",
                    "iss": "https://app.astropods.com",
                    "anyone_adapters": anyone_adapters,
                }
            ),
            "signature",
        ]
    )


@pytest.mark.parametrize(
    "case", FIXTURE["deployToken"], ids=lambda c: c["name"]
)
def test_parity_deploy_token_decoding(case: dict[str, Any]):
    if case.get("expectError"):
        with pytest.raises(Exception):
            decode_deploy_token(case["token"])
        return

    claims = decode_deploy_token(case["token"])
    assert claims.subject == case["expect"]["subject"]
    assert claims.issuer == case["expect"]["issuer"]
    assert claims.anyone_adapters == case["expect"]["anyoneAdapters"]


@pytest.mark.parametrize("case", FIXTURE["guard"], ids=lambda c: c["name"])
def test_parity_guard_outcomes(case: dict[str, Any]):
    _, http_get = server_stub(case["server"])
    authz = Authorizer(
        identity_token=token_for(case["anyoneAdapters"]),
        http_get=http_get,
        verify_identity=False,
    )

    outcome = guard(authz, case["headers"])
    assert outcome.status == case["expectStatus"]
    if "expectUserId" in case:
        assert outcome.principal is not None
        assert outcome.principal.user_id == case["expectUserId"]


@pytest.mark.parametrize(
    "case", FIXTURE["authorizeRequest"]["cases"], ids=lambda c: c["name"]
)
def test_parity_authorize_request_shape(case: dict[str, Any]):
    calls, http_get = server_stub({"allowed": True})
    authz = Authorizer(
        identity_token=token_for([]), http_get=http_get, verify_identity=False
    )

    authz.authorize(
        Principal(user_id=case["userId"], source="alb") if case["userId"] else None
    )

    assert calls[0] == case["expectParams"]
