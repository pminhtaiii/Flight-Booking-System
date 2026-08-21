import time

import jwt
import pytest

from agent.auth.claim_token import create_claim_token
from agent.config import Settings
from agent.utils.auth import decode_and_verify_jwt


def test_jwt_verification_single_and_ring():
    secret_v1 = "test-jwt-secret-v1-grace"
    secret_v2 = "test-jwt-secret-v2-active"
    issuer = "booking-systems-api"
    audience = "booking-systems-clients"

    # Token minted with V1
    token_v1 = jwt.encode(
        {
            "sub": "user_123",
            "jti": "jti_123",
            "iss": issuer,
            "aud": audience,
            "exp": int(time.time()) + 3600,
        },
        secret_v1,
        algorithm="HS256",
    )

    # Token minted with V2
    token_v2 = jwt.encode(
        {
            "sub": "user_456",
            "jti": "jti_456",
            "iss": issuer,
            "aud": audience,
            "exp": int(time.time()) + 3600,
        },
        secret_v2,
        algorithm="HS256",
    )

    # Token minted with unknown secret
    token_invalid = jwt.encode(
        {
            "sub": "user_789",
            "jti": "jti_789",
            "iss": issuer,
            "aud": audience,
            "exp": int(time.time()) + 3600,
        },
        "unknown-secret",
        algorithm="HS256",
    )

    # Ring containing V2 as primary and V1 in ring
    secret_ring = [secret_v2, secret_v1]

    # Both V1 and V2 tokens should decode successfully against the ring
    decoded_v1 = decode_and_verify_jwt(token_v1, secret_ring, issuer=issuer, audience=audience)
    assert decoded_v1["sub"] == "user_123"

    decoded_v2 = decode_and_verify_jwt(token_v2, secret_ring, issuer=issuer, audience=audience)
    assert decoded_v2["sub"] == "user_456"

    # Invalid token rejected
    with pytest.raises(jwt.InvalidTokenError):
        decode_and_verify_jwt(token_invalid, secret_ring, issuer=issuer, audience=audience)


def test_settings_key_rings(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "jwt-base")
    monkeypatch.setenv("JWT_SECRET_CURRENT", "jwt-current")
    monkeypatch.setenv("JWT_SECRET_PREVIOUS", "jwt-previous")
    monkeypatch.setenv("CLAIM_TOKEN_SECRET", "claim-base")
    monkeypatch.setenv("CLAIM_TOKEN_SECRET_CURRENT", "claim-current")
    monkeypatch.setenv("CLAIM_TOKEN_SECRET_PREVIOUS", "claim-previous")
    monkeypatch.setenv("AGENT_SERVICE_API_KEY", "agent-key")
    monkeypatch.setenv("NESTJS_API_URL", "http://localhost:3001")

    settings = Settings()

    assert "jwt-current" in settings.jwt_secret_ring
    assert "jwt-previous" in settings.jwt_secret_ring
    assert settings.jwt_secret_ring[0] == "jwt-current"

    assert settings.primary_claim_token_secret == "claim-current"
    assert "claim-current" in settings.claim_token_secret_ring
    assert "claim-previous" in settings.claim_token_secret_ring


def test_create_claim_token_with_rotation():
    secret_active = "claim-secret-active"
    token = create_claim_token("user_test", secret_active)
    parts = token.split(".")
    assert len(parts) == 2
