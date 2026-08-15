import pytest
import httpx
import jwt
import base64
import json
from unittest.mock import AsyncMock, patch
from agent.tools.nestjs_client import NestJSClient
from agent.config import get_settings

_CHECK_USER_ACCESS = NestJSClient.check_user_access


@pytest.mark.asyncio
async def test_check_user_access_uses_configured_api_base_once(monkeypatch):
    monkeypatch.setattr(NestJSClient, "check_user_access", _CHECK_USER_ACCESS)
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request(
        "POST",
        "http://localhost:3001/api/agent-gateway/chat/access/check",
    )
    mock_response = httpx.Response(200, json={"allowed": True}, request=req)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        result = await client.check_user_access(sub="user-123", jti="jti-456")

    assert result == {"allowed": True}
    assert mock_post.await_args.args[0] == (
        "http://localhost:3001/api/agent-gateway/chat/access/check"
    )


@pytest.mark.asyncio
async def test_gateway_request_accepts_canonical_chat_jwt():
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": "user-123",
            "jti": "jti-456",
            "iss": "booking-systems-api",
            "aud": "booking-systems-clients",
            "exp": 9999999999,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)
    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/chat/sessions")
    mock_response = httpx.Response(201, json={"id": "session-123"}, request=req)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        result = await client.create_session()

    assert result == {"id": "session-123"}
    headers = mock_post.await_args.kwargs["headers"]
    assert headers["X-Agent-API-Key"] == settings.AGENT_SERVICE_API_KEY
    assert headers["X-User-Claim"]


@pytest.fixture(autouse=True)
def mock_time():
    with patch("time.time", return_value=1782960317.0):
        yield


def test_set_fencing_token():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token", fencing_token=42)
    assert client.fencing_token == 42
    assert client.headers["X-Fencing-Token"] == "42"
    assert client.headers["Authorization"] == "Bearer test-token"

    client.set_fencing_token(None)
    assert client.fencing_token is None
    assert "X-Fencing-Token" not in client.headers

    client.set_fencing_token(99)
    assert client.fencing_token == 99
    assert client.headers["X-Fencing-Token"] == "99"


@pytest.mark.asyncio
async def test_create_session():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")

    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/chat/sessions")
    mock_response = httpx.Response(201, json={"id": "session-123", "title": "New Session"}, request=req)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        result = await client.create_session(title="New Session")

        assert result == {"id": "session-123", "title": "New Session"}
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        assert args[0] == "http://localhost:3001/api/agent-gateway/chat/sessions"
        assert kwargs["json"] == {"title": "New Session"}
        assert "X-Agent-API-Key" in kwargs["headers"]
        assert "X-User-Claim" in kwargs["headers"]


@pytest.mark.asyncio
async def test_create_message():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/messages")
    mock_response = httpx.Response(201, json={"id": "msg-123", "content": "hello"}, request=req)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        result = await client.create_message(
            session_id="session-123",
            sender="USER",
            message_type="STANDARD",
            content="hello"
        )

        assert result == {"id": "msg-123", "content": "hello"}
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        assert args[0] == "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/messages"
        assert kwargs["json"] == {"sender": "USER", "type": "STANDARD", "content": "hello"}
        assert "X-Agent-API-Key" in kwargs["headers"]
        assert "X-User-Claim" in kwargs["headers"]


@pytest.mark.asyncio
async def test_create_message_batch():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/turns")
    mock_response = httpx.Response(201, json={"id": "msg-123"}, request=req)

    messages = [
        {"sender": "USER", "type": "STANDARD", "content": "hello"},
        {"sender": "AGENT", "type": "STANDARD", "content": "hi"}
    ]

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        result = await client.create_message_batch(
            session_id="session-123",
            messages=messages
        )

        assert result == {"id": "msg-123"}
        assert mock_post.call_count == 1
        args, kwargs = mock_post.call_args
        assert args[0] == "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/turns"
        assert "messages" in kwargs["json"]
        assert len(kwargs["json"]["messages"]) == 2
        assert kwargs["json"]["messages"][0]["sender"] == "USER"
        assert kwargs["json"]["messages"][1]["sender"] == "AGENT"
        assert "X-Agent-API-Key" in kwargs["headers"]
        assert "X-User-Claim" in kwargs["headers"]


@pytest.mark.asyncio
async def test_get_memory():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/memory")
    mock_response = httpx.Response(200, json={"summary": None, "recentMessages": []}, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_memory(session_id="session-123", recent_count=20)

        assert result == {"summary": None, "recentMessages": []}
        mock_get.assert_called_once()
        args, kwargs = mock_get.call_args
        assert args[0] == "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/memory"
        assert kwargs["params"] == {"recentCount": 20}
        assert "X-Agent-API-Key" in kwargs["headers"]
        assert "X-User-Claim" in kwargs["headers"]


@pytest.mark.asyncio
async def test_get_memory_unsummarized_only():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/memory")
    mock_response = httpx.Response(200, json={"summary": None, "recentMessages": []}, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_memory(session_id="session-123", recent_count=20, unsummarized_only=True)

        assert result == {"summary": None, "recentMessages": []}
        mock_get.assert_called_once()
        args, kwargs = mock_get.call_args
        assert args[0] == "http://localhost:3001/api/agent-gateway/chat/sessions/session-123/memory"
        assert kwargs["params"] == {"recentCount": 20, "unsummarizedOnly": "true"}
        assert "X-Agent-API-Key" in kwargs["headers"]
        assert "X-User-Claim" in kwargs["headers"]


@pytest.mark.asyncio
async def test_get_gateway_headers_valid_signature():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    headers = client._get_gateway_headers()
    assert headers["X-Agent-API-Key"] == settings.AGENT_SERVICE_API_KEY
    assert "X-User-Claim" in headers

    # decode the user claim to verify
    claim = headers["X-User-Claim"]
    payload_b64 = claim.split(".")[0]
    missing_padding = len(payload_b64) % 4
    if missing_padding:
        payload_b64 += '=' * (4 - missing_padding)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode('utf-8'))
    assert payload["userId"] == "user-123"


def test_get_gateway_headers_propagates_only_opaque_trace_and_correlation_ids():
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": "user-123",
            "jti": "jti-456",
            "iss": "booking-systems-api",
            "aud": "booking-systems-clients",
            "exp": 9999999999,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    trace_id = "chat_" + ("a1" * 16)
    client = NestJSClient(
        base_url="http://localhost:3001/api",
        token=token,
        trace_id=trace_id,
        correlation_id="session-123",
    )

    headers = client._get_gateway_headers()

    assert headers["X-Trace-ID"] == trace_id
    assert headers["X-Correlation-ID"].startswith("chat_")
    assert headers["X-Correlation-ID"] != "session-123"


@pytest.mark.asyncio
async def test_create_handoff_uses_the_nestjs_dto_contract():
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": "user-123",
            "jti": "jti-456",
            "iss": "booking-systems-api",
            "aud": "booking-systems-clients",
            "exp": 9999999999,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)
    request = httpx.Request("POST", "http://localhost:3001/api/chat-handoff")
    response = httpx.Response(201, json={"token": "opaque", "expiresAt": "2026-08-09T00:00:00Z"}, request=request)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = response

        result = await client.create_handoff("signed-attestation", 2, fingerprint="must-not-cross-boundary")

    _, kwargs = mock_post.call_args
    assert kwargs["json"] == {
        "selectionAttestationHash": "signed-attestation",
        "selectedOfferIndex": 2,
    }
    assert result == {
        "handoffToken": "opaque",
        "expiresAt": "2026-08-09T00:00:00Z",
        "display": None,
    }


@pytest.mark.asyncio
async def test_create_handoff_token_sends_exact_payload_and_omits_forbidden_fields():
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": "user-123",
            "jti": "jti-456",
            "iss": "booking-systems-api",
            "aud": "booking-systems-clients",
            "exp": 9999999999,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)
    request = httpx.Request("POST", "http://localhost:3001/api/chat-handoff")
    response = httpx.Response(
        201,
        json={"handoffToken": "ht_xyz123", "expiresAt": "2026-08-15T12:00:00Z", "display": {"offer": "VN123"}},
        request=request,
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = response

        result = await client.create_handoff_token(
            attestation="attestation-hash-abc",
            selected_offer_index=0,
            fingerprint="fingerprint-must-be-omitted",
        )

    args, kwargs = mock_post.call_args
    assert args[0] == "http://localhost:3001/api/chat-handoff"
    # a) sends exact payload
    assert kwargs["json"] == {
        "selectionAttestationHash": "attestation-hash-abc",
        "selectedOfferIndex": 0,
    }
    # b) omits caller-supplied session IDs / idempotency keys / fingerprint
    assert "sessionId" not in kwargs["json"]
    assert "session_id" not in kwargs["json"]
    assert "idempotencyKey" not in kwargs["json"]
    assert "idempotency_key" not in kwargs["json"]
    assert "fingerprint" not in kwargs["json"]


@pytest.mark.asyncio
async def test_create_handoff_token_propagates_trace_and_correlation_headers():
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": "user-123",
            "jti": "jti-456",
            "iss": "booking-systems-api",
            "aud": "booking-systems-clients",
            "exp": 9999999999,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    client = NestJSClient(
        base_url="http://localhost:3001/api",
        token=token,
        fencing_token=42,
    )
    request = httpx.Request("POST", "http://localhost:3001/api/chat-handoff")
    response = httpx.Response(
        201,
        json={"handoffToken": "token-opaque", "expiresAt": "2026-08-15T12:00:00Z"},
        request=request,
    )

    trace_id = "chat_" + ("11" * 16)
    correlation_id = "chat_" + ("22" * 16)

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = response

        result = await client.create_handoff_token(
            attestation="attestation-hash",
            selected_offer_index=1,
            trace_id=trace_id,
            correlation_id=correlation_id,
        )

    _, kwargs = mock_post.call_args
    headers = kwargs["headers"]
    # c) propagates trace_id and correlation_id headers along with gateway auth and fencing token
    assert headers["X-Trace-ID"] == trace_id
    assert headers["X-Correlation-ID"] == correlation_id
    assert headers["X-Agent-API-Key"] == settings.AGENT_SERVICE_API_KEY
    assert "X-User-Claim" in headers
    assert headers["X-Fencing-Token"] == "42"


@pytest.mark.asyncio
async def test_create_handoff_token_returns_handoff_token_expires_at_and_display():
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": "user-123",
            "jti": "jti-456",
            "iss": "booking-systems-api",
            "aud": "booking-systems-clients",
            "exp": 9999999999,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)
    request = httpx.Request("POST", "http://localhost:3001/api/chat-handoff")

    # d) returns handoffToken, expiresAt, and display with handoffToken field
    response_with_handoff_token = httpx.Response(
        201,
        json={
            "handoffToken": "ht_999",
            "expiresAt": "2026-08-15T15:30:00Z",
            "display": {"summary": "SGN -> HAN Flight", "price": 1500000},
        },
        request=request,
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = response_with_handoff_token

        result = await client.create_handoff_token(
            attestation="attestation-hash",
            selected_offer_index=2,
        )

    assert result == {
        "handoffToken": "ht_999",
        "expiresAt": "2026-08-15T15:30:00Z",
        "display": {"summary": "SGN -> HAN Flight", "price": 1500000},
    }

    # d) returns handoffToken when backend body uses "token" field fallback
    response_with_token = httpx.Response(
        201,
        json={
            "token": "tok_legacy_888",
            "expiresAt": "2026-08-15T15:30:00Z",
            "display": None,
        },
        request=request,
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = response_with_token

        result = await client.create_handoff_token(
            attestation="attestation-hash",
            selected_offer_index=2,
        )

    assert result == {
        "handoffToken": "tok_legacy_888",
        "expiresAt": "2026-08-15T15:30:00Z",
        "display": None,
    }



@pytest.mark.asyncio
async def test_get_gateway_headers_invalid_signature_fallback():
    # Sign with a different secret (>= 32 bytes to avoid warning)
    token = jwt.encode({"sub": "user-456"}, "wrong-secret-key-that-is-at-least-32-bytes-long!", algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    with pytest.raises(ValueError) as excinfo:
        client._get_gateway_headers()
    assert "Invalid authentication token" in str(excinfo.value)


@pytest.mark.asyncio
async def test_get_gateway_headers_missing_claims():
    settings = get_settings()
    token = jwt.encode({"email": "test@example.com"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    with pytest.raises(ValueError) as excinfo:
        client._get_gateway_headers()
    assert "Token is missing user identification claims" in str(excinfo.value)


@pytest.mark.asyncio
async def test_get_gateway_flights_search():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/flights/search")
    mock_response = httpx.Response(200, json={"flights": []}, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_flights_search(
            origin="SGN",
            destination="HAN",
            date="2026-08-01",
            passengers=2
        )

        assert result == {"flights": []}

        # Verify the headers passed
        headers = client._get_gateway_headers()
        mock_get.assert_called_once_with(
            "http://localhost:3001/api/agent-gateway/flights/search",
            params={
                "origin": "SGN",
                "destination": "HAN",
                "date": "2026-08-01",
                "passengers": 2
            },
            headers=headers
        )


@pytest.mark.asyncio
async def test_get_gateway_user_preferences():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/preferences")
    mock_response = httpx.Response(200, json={"preferences": {}}, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_user_preferences()
        assert result == {"preferences": {}}

        headers = client._get_gateway_headers()
        mock_get.assert_called_once_with(
            "http://localhost:3001/api/agent-gateway/users/preferences",
            headers=headers
        )


@pytest.mark.asyncio
async def test_get_gateway_user_booking_summaries():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    trace_id = "chat_" + ("a1" * 16)
    client = NestJSClient(
        base_url="http://localhost:3001/api",
        token=token,
        trace_id=trace_id,
        correlation_id="session-123",
    )

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/bookings/summaries")
    mock_payload = {
        "bookings": [
            {
                "bookingReference": "bkref_12345",
                "airline": "VN",
                "origin": "SGN",
                "destination": "NRT",
                "departureTime": "2026-09-20T02:00:00.000Z",
                "arrivalTime": "2026-09-20T08:30:00.000Z",
                "status": "CONFIRMED",
                "durationMinutes": 330,
                "stops": 0,
            }
        ]
    }
    mock_response = httpx.Response(200, json=mock_payload, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_user_booking_summaries()
        assert result == mock_payload

        headers = client._get_gateway_headers()
        assert "X-Agent-API-Key" in headers
        assert "X-User-Claim" in headers
        assert headers["X-Trace-ID"] == trace_id
        assert "X-Correlation-ID" in headers
        mock_get.assert_called_once_with(
            "http://localhost:3001/api/agent-gateway/users/bookings/summaries",
            headers=headers,
        )


@pytest.mark.asyncio
async def test_get_gateway_booking_detail():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    trace_id = "chat_" + ("b2" * 16)
    client = NestJSClient(
        base_url="http://localhost:3001/api",
        token=token,
        trace_id=trace_id,
        correlation_id="session-456",
    )

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/bookings/bkref_12345")
    mock_payload = {
        "bookingReference": "bkref_12345",
        "airline": "VN",
        "origin": "SGN",
        "destination": "NRT",
        "departureTime": "2026-09-20T02:00:00.000Z",
        "arrivalTime": "2026-09-20T08:30:00.000Z",
        "status": "CONFIRMED",
        "durationMinutes": 330,
        "stops": 0,
        "flightNumber": "VN300",
        "baggageAllowance": "1 checked bag",
        "changeable": True,
        "refundable": False,
    }
    mock_response = httpx.Response(200, json=mock_payload, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_booking_detail("bkref_12345")
        assert result == mock_payload

        headers = client._get_gateway_headers()
        assert "X-Agent-API-Key" in headers
        assert "X-User-Claim" in headers
        assert headers["X-Trace-ID"] == trace_id
        assert "X-Correlation-ID" in headers
        mock_get.assert_called_once_with(
            "http://localhost:3001/api/agent-gateway/users/bookings/bkref_12345",
            headers=headers,
        )


@pytest.mark.asyncio
async def test_get_gateway_booking_detail_not_found():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/bookings/bkref_99999")
    mock_response = httpx.Response(
        404,
        json={
            "statusCode": 404,
            "message": "Booking reference not found",
            "code": "BOOKING_REFERENCE_NOT_FOUND",
        },
        request=req,
    )

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_booking_detail("bkref_99999")
        assert result.get("statusCode") == 404 or result.get("error") == "BOOKING_REFERENCE_NOT_FOUND" or "not found" in str(result).lower()


@pytest.mark.asyncio
async def test_get_gateway_booking_detail_malformed_reference():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        with pytest.raises(ValueError):
            await client.get_gateway_booking_detail("invalid_ref_no_prefix")
        mock_get.assert_not_called()


@pytest.mark.asyncio
async def test_get_gateway_flights_search_400_error():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/flights/search")
    mock_response = httpx.Response(
        400,
        json={"statusCode": 400, "message": "I can currently only search economy class for adult passengers..."},
        request=req
    )

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_flights_search(
            origin="SGN",
            destination="HAN",
            date="2026-08-01",
            passengers=1
        )

        assert result == {"error": "I can currently only search economy class for adult passengers..."}


@pytest.mark.asyncio
async def test_check_booking_readiness_success():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/bookings/readiness")
    mock_response = httpx.Response(
        200,
        json={
            "scope": "DOMESTIC",
            "ready": False,
            "passengers": [],
            "nextAction": "COMPLETE_PROFILE"
        },
        request=req
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        result = await client.check_booking_readiness(
            flight_offer_id="offer-123",
            passengers=[{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "inline"}]
        )

        assert result.get("ready") is False
        assert result.get("nextAction") == "COMPLETE_PROFILE"

        headers = client._get_gateway_headers()
        mock_post.assert_called_once_with(
            "http://localhost:3001/api/agent-gateway/bookings/readiness",
            json={
                "flightOfferId": "offer-123",
                "passengers": [{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "inline"}]
            },
            headers=headers
        )


@pytest.mark.asyncio
async def test_check_booking_readiness_rejects_pii():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    with pytest.raises(ValueError, match="invalid keys"):
        await client.check_booking_readiness(
            flight_offer_id="offer-123",
            passengers=[{
                "passengerType": "ADULT",
                "passengerOrdinal": 1,
                "sourceType": "inline",
                "givenName": "John"  # Not allowed
            }]
        )


@pytest.mark.asyncio
async def test_check_booking_readiness_unexpected_keys():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/bookings/readiness")
    mock_response = httpx.Response(
        200,
        json={
            "scope": "DOMESTIC",
            "ready": True,
            "passengers": [],
            "nextAction": "CONTINUE_CHECKOUT",
            "internalProfileId": "secret-123" # Unexpected key
        },
        request=req
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        result = await client.check_booking_readiness(
            flight_offer_id="offer-123",
            passengers=[{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "inline"}]
        )
        assert "error" in result
        assert "malformed" in result["error"]


@pytest.mark.asyncio
async def test_check_booking_readiness_redacts_value_bearing_gateway_errors():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)
    request = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/bookings/readiness")
    mock_response = httpx.Response(
        422,
        json={"message": "Ada Lovelace passport P12345678"},
        request=request,
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        result = await client.check_booking_readiness(
            flight_offer_id="offer-123",
            passengers=[{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "inline"}],
        )

    assert result == {"error": "Booking readiness could not be verified safely."}
    assert "Ada Lovelace" not in str(result)


@pytest.mark.asyncio
async def test_check_booking_readiness_rejects_nested_value_bearing_response():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/bookings/readiness")
    mock_response = httpx.Response(
        200,
        json={
            "scope": "DOMESTIC",
            "ready": False,
            "nextAction": "COMPLETE_PROFILE",
            "passengers": [{
                "passengerType": "ADULT",
                "passengerOrdinal": 1,
                "sections": [],
                "givenName": "Ada",
            }],
        },
        request=req,
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        result = await client.check_booking_readiness(
            flight_offer_id="offer-123",
            passengers=[{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "inline"}],
        )

    assert result == {"error": "Received malformed readiness response from server."}


@pytest.mark.asyncio
async def test_check_booking_readiness_does_not_return_gateway_error_message():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)
    req = httpx.Request("POST", "http://localhost:3001/api/agent-gateway/bookings/readiness")
    mock_response = httpx.Response(
        400,
        json={"message": "Passport for Ada Lovelace is invalid"},
        request=req,
    )

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        result = await client.check_booking_readiness(
            flight_offer_id="offer-123",
            passengers=[{"passengerType": "ADULT", "passengerOrdinal": 1, "sourceType": "inline"}],
        )

    assert result == {"error": "Booking readiness could not be verified safely."}
