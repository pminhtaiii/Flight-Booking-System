import base64
import hashlib
import hmac
import json

from agent.auth.claim_token import create_claim_token


def test_claim_token_generation():
    user_id = "user_123"
    secret = "my_claim_secret_key"

    token = create_claim_token(user_id=user_id, secret=secret)

    parts = token.split(".")
    assert len(parts) == 2

    payload_b64, sig_b64 = parts

    # Decode payload
    missing_padding = len(payload_b64) % 4
    if missing_padding:
        payload_b64 += "=" * (4 - missing_padding)

    payload_json = base64.urlsafe_b64decode(payload_b64).decode("utf-8")
    payload = json.loads(payload_json)

    assert payload["userId"] == user_id
    assert "iat" in payload
    assert isinstance(payload["iat"], int)

    # Verify signature
    payload_bytes = payload_json.encode("utf-8")
    secret_bytes = secret.encode("utf-8")
    expected_sig_bytes = hmac.new(secret_bytes, payload_bytes, hashlib.sha256).digest()
    expected_sig_b64 = base64.urlsafe_b64encode(expected_sig_bytes).decode("utf-8").rstrip("=")

    assert sig_b64 == expected_sig_b64


def test_claim_token_with_custom_iat():
    user_id = "user_456"
    secret = "another_secret"
    iat = 1719878400  # specific timestamp

    token = create_claim_token(user_id=user_id, secret=secret, iat=iat)
    parts = token.split(".")
    payload_b64 = parts[0]

    missing_padding = len(payload_b64) % 4
    if missing_padding:
        payload_b64 += "=" * (4 - missing_padding)

    payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
    assert payload["userId"] == user_id
    assert payload["iat"] == iat
