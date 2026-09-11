from __future__ import annotations

import base64
import json
from typing import Any

import pytest

from astropods_adapter_core.auth import IdentityTokenError, decode_deploy_token


def token(payload: dict[str, Any]) -> str:
    def encode(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{encode({'alg': 'HS256'})}.{encode(payload)}.signature"


def test_reads_the_deployment_id_server_url_and_open_adapters():
    claims = decode_deploy_token(
        token(
            {
                "sub": "dep_123",
                "iss": "https://app.astropods.com",
                "anyone_adapters": ["web", "custom"],
            }
        )
    )
    assert claims.subject == "dep_123"
    assert claims.issuer == "https://app.astropods.com"
    assert claims.anyone_adapters == ["web", "custom"]


def test_defaults_open_adapters_to_empty_when_the_claim_is_absent():
    claims = decode_deploy_token(
        token({"sub": "dep_123", "iss": "https://app.astropods.com"})
    )
    assert claims.anyone_adapters == []


def test_rejects_a_token_with_no_issuer_since_it_carries_the_server_url():
    with pytest.raises(IdentityTokenError):
        decode_deploy_token(token({"sub": "dep_123"}))


@pytest.mark.parametrize("raw", ["", "not.a.jwt", "onlyonesegment"])
def test_rejects_a_structurally_invalid_token_rather_than_downgrading(raw: str):
    with pytest.raises(IdentityTokenError):
        decode_deploy_token(raw)
