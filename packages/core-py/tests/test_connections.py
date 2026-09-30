from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from astropods_adapter_core.connections import ConnectionClient, ConnectionTokenError

SERVER = "https://app.astropods.com"


def deploy_token() -> str:
    def encode(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return ".".join([encode({"alg": "HS256", "typ": "JWT"}), encode({"sub": "dep_1", "iss": SERVER}), "signature"])


class StubResponse:
    def __init__(self, body: Any, status_code: int = 200) -> None:
        self._body = body
        self.status_code = status_code

    def json(self) -> Any:
        return self._body


class Recorder:
    def __init__(self, respond) -> None:
        self.calls: list[dict[str, Any]] = []
        self._respond = respond

    def __call__(self, url: str, **kwargs: Any) -> StubResponse:
        self.calls.append({"url": url, **kwargs})
        return self._respond(kwargs)


def in_an_hour() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")


def test_posts_the_user_and_provider_with_the_deploy_token():
    post = Recorder(lambda _: StubResponse({"access_token": "gho_1", "scopes": ["repo"]}))
    tok = ConnectionClient(identity_token=deploy_token(), http_post=post).get_token("github", "user_1")

    assert tok.access_token == "gho_1"
    assert tok.scopes == ["repo"]
    assert post.calls[0]["url"] == f"{SERVER}/api/v1/deployments/connections/token"
    assert post.calls[0]["json"] == {"user_id": "user_1", "provider": "github"}
    assert post.calls[0]["headers"]["authorization"] == f"Bearer {deploy_token()}"


def test_reuses_a_token_until_shortly_before_it_expires():
    post = Recorder(lambda _: StubResponse({"access_token": "gho_1", "expires_at": in_an_hour()}))
    client = ConnectionClient(identity_token=deploy_token(), http_post=post)
    client.get_token("github", "user_1")
    client.get_token("github", "user_1")
    assert len(post.calls) == 1


def test_caches_per_user_so_one_users_token_never_serves_another():
    post = Recorder(lambda kw: StubResponse({"access_token": f"tok-{kw['json']['user_id']}", "expires_at": in_an_hour()}))
    client = ConnectionClient(identity_token=deploy_token(), http_post=post)
    assert client.get_token("github", "user_a").access_token == "tok-user_a"
    assert client.get_token("github", "user_b").access_token == "tok-user_b"
    assert len(post.calls) == 2


def test_refetches_a_token_with_no_expiry_every_time():
    post = Recorder(lambda _: StubResponse({"access_token": "gho_1"}))
    client = ConnectionClient(identity_token=deploy_token(), http_post=post)
    client.get_token("github", "user_1")
    client.get_token("github", "user_1")
    assert len(post.calls) == 2


@pytest.mark.parametrize(
    "status,code",
    [(403, "not_consented"), (403, "not_active"), (409, "not_connected"), (409, "needs_reauthorization")],
)
def test_a_refusal_surfaces_its_code(status: int, code: str):
    post = Recorder(lambda _: StubResponse({"error": code}, status))
    with pytest.raises(ConnectionTokenError) as info:
        ConnectionClient(identity_token=deploy_token(), http_post=post).get_token("github", "user_1")
    assert info.value.code == code
    assert info.value.status == status


def test_an_unrecognized_refusal_is_unavailable():
    post = Recorder(lambda _: StubResponse({"error": "token_unavailable"}, 502))
    with pytest.raises(ConnectionTokenError) as info:
        ConnectionClient(identity_token=deploy_token(), http_post=post).get_token("github", "user_1")
    assert info.value.code == "unavailable"


def test_an_unreachable_server_is_unavailable():
    def post(url: str, **kwargs: Any):
        raise OSError("connection refused")

    with pytest.raises(ConnectionTokenError) as info:
        ConnectionClient(identity_token=deploy_token(), http_post=post).get_token("github", "user_1")
    assert info.value.code == "unavailable"


def test_a_turn_with_no_user_is_refused_without_a_request():
    post = Recorder(lambda _: StubResponse({}))
    with pytest.raises(ConnectionTokenError) as info:
        ConnectionClient(identity_token=deploy_token(), http_post=post).get_token("github", "")
    assert info.value.code == "not_consented"
    assert post.calls == []


async def test_the_async_form_posts_the_same_request_and_shares_the_cache():
    calls: list[dict[str, Any]] = []

    async def post(url: str, **kwargs: Any) -> StubResponse:
        calls.append({"url": url, **kwargs})
        return StubResponse({"access_token": "gho_1", "expires_at": in_an_hour()})

    client = ConnectionClient(identity_token=deploy_token(), async_http_post=post)
    tok = await client.get_token_async("github", "user_1")
    again = await client.get_token_async("github", "user_1")
    assert tok.access_token == again.access_token == "gho_1"
    assert calls[0]["json"] == {"user_id": "user_1", "provider": "github"}
    assert len(calls) == 1
