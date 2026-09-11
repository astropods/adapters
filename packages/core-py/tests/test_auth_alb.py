from __future__ import annotations

import base64
import json
import time
from typing import Any, Optional

import pytest

jwt = pytest.importorskip("jwt")
ec = pytest.importorskip("cryptography.hazmat.primitives.asymmetric.ec")
serialization = pytest.importorskip("cryptography.hazmat.primitives.serialization")

from astropods_adapter_core.auth import AlbIdentityVerifier, region_from_signer_arn

SIGNER = (
    "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/router/abc123"
)

_private = ec.generate_private_key(ec.SECP256R1())
_other = ec.generate_private_key(ec.SECP256R1())
PEM = (
    _private.public_key()
    .public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    .decode()
)


def alb_token(
    claims: Optional[dict[str, Any]] = None,
    header: Optional[dict[str, Any]] = None,
    key: Any = None,
) -> str:
    """Mirrors the ALB's layout: user claims in the payload, exp in the header."""
    full_header = {
        "kid": "kid-1",
        "signer": SIGNER,
        "exp": int(time.time()) + 600,
    }
    full_header.update(header or {})
    return jwt.encode(
        claims or {"sub": "user_1", "email": "a@b.com"},
        key or _private,
        algorithm="ES256",
        headers=full_header,
    )


def verifier(pem: str = PEM) -> AlbIdentityVerifier:
    return AlbIdentityVerifier(fetch_key=lambda kid, region: pem)


def test_returns_the_callers_identity_from_a_well_formed_token():
    p = verifier().verify(alb_token())
    assert p.user_id == "user_1"
    assert p.email == "a@b.com"
    assert p.source == "alb"


def test_rejects_a_token_signed_by_a_key_that_is_not_the_albs():
    with pytest.raises(Exception):
        verifier().verify(alb_token(key=_other))


def test_rejects_a_tampered_payload():
    head, _, sig = alb_token().split(".")
    swapped = (
        base64.urlsafe_b64encode(json.dumps({"sub": "user_admin"}).encode())
        .decode()
        .rstrip("=")
    )
    with pytest.raises(Exception):
        verifier().verify(f"{head}.{swapped}.{sig}")


def test_rejects_a_token_whose_header_expiry_has_passed():
    with pytest.raises(ValueError, match="expired"):
        verifier().verify(alb_token(header={"exp": int(time.time()) - 1}))


def test_rejects_an_algorithm_downgrade():
    token = jwt.encode({"sub": "user_1"}, key=None, algorithm="none")
    with pytest.raises(ValueError, match="unexpected alg"):
        verifier().verify(token)


def test_rejects_a_token_carrying_no_subject_to_authorize():
    with pytest.raises(ValueError, match="sub"):
        verifier().verify(alb_token(claims={"email": "a@b.com"}))


def test_fetches_each_key_once_and_reuses_it():
    fetches = 0

    def fetch(kid: str, region: str) -> str:
        nonlocal fetches
        fetches += 1
        return PEM

    v = AlbIdentityVerifier(fetch_key=fetch)
    v.verify(alb_token())
    v.verify(alb_token())
    assert fetches == 1


def test_fails_when_no_region_can_be_determined_for_the_key_lookup():
    with pytest.raises(ValueError, match="region"):
        verifier().verify(alb_token(header={"signer": None}))


def test_region_from_signer_arn_reads_the_region():
    assert region_from_signer_arn(SIGNER) == "us-east-1"


@pytest.mark.parametrize("arn", [None, "not-an-arn", "arn:aws:elb::123:lb"])
def test_region_from_signer_arn_returns_none_for_malformed_input(arn):
    assert region_from_signer_arn(arn) is None
