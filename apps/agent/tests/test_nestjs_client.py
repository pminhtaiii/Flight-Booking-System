import pytest
import httpx
import jwt
import base64
import json
from unittest.mock import AsyncMock, patch
from agent.tools.nestjs_client import NestJSClient
from agent.config import get_settings


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

@pytest.mark.asyncio
async def test_get_gateway_headers_invalid_signature_fallback():
    # Sign with a different secret
    token = jwt.encode({"sub": "user-456"}, "wrong-secret", algorithm="HS256")
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
async def test_get_gateway_user_bookings():
    settings = get_settings()
    token = jwt.encode({"id": "user-123"}, settings.JWT_SECRET, algorithm="HS256")
    client = NestJSClient(base_url="http://localhost:3001/api", token=token)

    req = httpx.Request("GET", "http://localhost:3001/api/agent-gateway/users/bookings")
    mock_response = httpx.Response(200, json={"bookings": []}, request=req)

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response

        result = await client.get_gateway_user_bookings()
        assert result == {"bookings": []}

        headers = client._get_gateway_headers()
        mock_get.assert_called_once_with(
            "http://localhost:3001/api/agent-gateway/users/bookings",
            headers=headers
        )


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
