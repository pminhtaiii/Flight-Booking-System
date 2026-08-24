import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionHandoffPayload,
    ActionRequiredEvent,
    ActionRequiredPayload,
    DoneEvent,
    DonePayload,
    ErrorEvent,
    ErrorPayload,
    FlightResultsEvent,
    FlightResultsPayload,
    TokenEvent,
    TokenPayload,
    ToolCallEvent,
    ToolCallPayload,
    ToolResultEvent,
    ToolResultPayload,
)
from agent.config import get_settings
from agent.main import active_runners, app, lifespan
from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    RedisUnavailableException,
)
from agent.tools.nestjs_client import NestJSClient

settings = get_settings()
client = TestClient(app)


def parse_sse(lines: list[str]) -> list[dict]:
    """Parse raw SSE lines into structured events."""
    events = []
    current: dict = {}
    for raw in lines:
        if isinstance(raw, bytes):
            line = raw.decode("utf-8").strip()
        else:
            line = raw.strip()
        if not line:
            if current:
                events.append(current)
                current = {}
            continue
        if line.startswith(":"):
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if key == "event":
                current["event"] = val
            elif key == "data":
                try:
                    current["data"] = json.loads(val)
                except Exception:
                    current["data"] = val
    if current:
        events.append(current)
    return events


def make_jwt(
    sub: str = "user-123",
    jti: str = "jti-uuid-456",
    iss: str | None = None,
    aud: str | None = None,
    exp: int | None = None,
    secret: str | None = None,
    extra: dict | None = None,
) -> str:
    """Generate a valid canonical JWT for testing."""
    sec = secret or settings.JWT_SECRET
    issuer = iss if iss is not None else getattr(settings, "JWT_ISSUER", "booking-systems-api")
    audience = (
        aud if aud is not None else getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")
    )
    payload = {
        "sub": sub,
        "id": sub,
        "jti": jti,
        "iss": issuer,
        "aud": audience,
        "exp": exp if exp is not None else int(time.time()) + 3600,
    }
    if extra:
        payload.update(extra)
    return jwt.encode(payload, sec, algorithm="HS256")


@pytest.fixture
def mock_nestjs_client():
    client_mock = MagicMock(spec=NestJSClient)
    client_mock.check_user_access = AsyncMock(return_value={"allowed": True})
    client_mock.create_session = AsyncMock(return_value={"id": "sess-test-123"})
    client_mock.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client_mock.create_message_batch = AsyncMock(
        return_value={
            "messages": [
                {"id": "msg-user-1", "sender": "USER"},
                {"id": "msg-agent-2", "sender": "AGENT"},
            ]
        }
    )
    return client_mock


@pytest.fixture(autouse=True)
def mock_guardrails(monkeypatch):
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)
    return mock_gr


# ===========================================================================
# 1. Pre-stream authentication checks
# ===========================================================================


def test_prestream_auth_missing_header():
    """Missing Authorization header returns 401."""
    response = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Origin": "http://localhost:3000"},
    )
    assert response.status_code == 401
    assert "authorization" in response.json().get("detail", "").lower()


def test_prestream_auth_malformed_header():
    """Malformed Authorization header format returns 401."""
    # Not Bearer scheme
    response = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": "Basic 12345", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 401

    # Missing token part
    response2 = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": "Bearer", "Origin": "http://localhost:3000"},
    )
    assert response2.status_code == 401


def test_prestream_auth_invalid_jwt_signature():
    """JWT signed with untrusted / invalid secret returns 401."""
    token = make_jwt(secret="wrong_secret_key_that_does_not_match")
    response = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 401
    assert "Invalid token" in response.json().get("detail", "")


def test_prestream_auth_expired_jwt():
    """Expired JWT token returns 401."""
    expired_token = make_jwt(exp=int(time.time()) - 300)
    response = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {expired_token}", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 401
    assert (
        "expired" in response.json().get("detail", "").lower()
        or "invalid" in response.json().get("detail", "").lower()
    )


def test_prestream_auth_tampered_missing_claims():
    """JWT missing canonical claims (sub or jti) returns 401."""
    # Missing jti
    payload_no_jti = {
        "sub": "user-123",
        "iss": getattr(settings, "JWT_ISSUER", "booking-systems-api"),
        "aud": getattr(settings, "JWT_AUDIENCE", "booking-systems-clients"),
        "exp": int(time.time()) + 3600,
    }
    token_no_jti = jwt.encode(payload_no_jti, settings.JWT_SECRET, algorithm="HS256")
    response = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {token_no_jti}", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 401

    # Missing sub
    payload_no_sub = {
        "jti": "jti-123",
        "iss": getattr(settings, "JWT_ISSUER", "booking-systems-api"),
        "aud": getattr(settings, "JWT_AUDIENCE", "booking-systems-clients"),
        "exp": int(time.time()) + 3600,
    }
    token_no_sub = jwt.encode(payload_no_sub, settings.JWT_SECRET, algorithm="HS256")
    response2 = client.post(
        "/chat/stream",
        json={"message": "hello"},
        headers={"Authorization": f"Bearer {token_no_sub}", "Origin": "http://localhost:3000"},
    )
    assert response2.status_code == 401


def test_prestream_auth_nestjs_access_denied(mock_nestjs_client):
    """NestJS access check denial (deactivated user or revoked token) returns 401."""
    token = make_jwt()
    mock_nestjs_client.check_user_access.return_value = {"allowed": False}

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client):
        response = client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 401
        assert "inactive or token revoked" in response.json().get("detail", "").lower()


# ===========================================================================
# 2. Pre-stream validation
# ===========================================================================


def test_prestream_validation_message_exceeds_max_length(monkeypatch):
    """Message exceeding settings.MAX_MESSAGE_LENGTH returns 400."""
    token = make_jwt()
    monkeypatch.setattr(settings, "MAX_MESSAGE_LENGTH", 20)

    response = client.post(
        "/chat/stream",
        json={"message": "This message is definitely longer than 20 characters."},
        headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 400
    assert "exceeds maximum length" in response.json().get("detail", "")


def test_prestream_validation_empty_or_whitespace_message_rejected():
    """Empty or whitespace-only message without confirmed flag returns 422 validation error."""
    token = make_jwt()
    response = client.post(
        "/chat/stream",
        json={"message": "    "},
        headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 422


# ===========================================================================
# 3. Pre-stream rate limiting / quota
# ===========================================================================


def test_prestream_quota_daily_limit_exceeded(monkeypatch):
    """Daily message quota exceeded raises 429 CHAT_DAILY_QUOTA_EXCEEDED."""
    token = make_jwt()
    mock_budget = MagicMock()
    mock_budget.admit_request = AsyncMock(
        side_effect=BudgetExceededException("Daily limit of 50 messages reached")
    )

    with (
        patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
    ):
        response = client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 429
        assert response.json().get("detail") == "CHAT_DAILY_QUOTA_EXCEEDED"


def test_prestream_quota_burst_limit_exceeded(monkeypatch):
    """Burst rate limit exceeded raises 429 CHAT_BURST_LIMIT_EXCEEDED."""
    token = make_jwt()
    mock_budget = MagicMock()
    mock_budget.admit_request = AsyncMock(
        side_effect=BudgetExceededException("Burst rate limit exceeded")
    )

    with (
        patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
    ):
        response = client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 429
        assert response.json().get("detail") == "CHAT_BURST_LIMIT_EXCEEDED"


def test_prestream_redis_client_none_raises_503(monkeypatch):
    """Redis client returning None / unavailable raises 503 CHAT_CONTROL_PLANE_UNAVAILABLE."""
    token = make_jwt()
    with patch("agent.streaming.sse.get_redis_client", return_value=None):
        response = client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 503
        assert response.json().get("detail") == "CHAT_CONTROL_PLANE_UNAVAILABLE"


def test_prestream_redis_unavailable_exception_raises_503(monkeypatch):
    """RedisUnavailableException during quota check raises 503 CHAT_CONTROL_PLANE_UNAVAILABLE."""
    token = make_jwt()
    mock_budget = MagicMock()
    mock_budget.admit_request = AsyncMock(
        side_effect=RedisUnavailableException("Redis cluster connection timeout")
    )

    with (
        patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
    ):
        response = client.post(
            "/chat/stream",
            json={"message": "hello"},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 503
        assert response.json().get("detail") == "CHAT_CONTROL_PLANE_UNAVAILABLE"


# ===========================================================================
# 4. Ingress safety / PII checks
# ===========================================================================


@pytest.mark.asyncio
async def test_ingress_pii_detected_yields_guardrail_blocked_event():
    """Detecting PII in user message yields SSE GUARDRAIL_BLOCKED ErrorEvent."""
    token = make_jwt()
    pii_message = "My contact email is customer@example.com and passport is N1234567 please help."

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.post(
            "/chat/stream",
            json={"message": pii_message},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")

        lines = [line async for line in response.aiter_lines()]
        events = parse_sse(lines)

        assert len(events) == 1
        assert events[0]["event"] == "error"
        assert events[0]["data"]["code"] == "GUARDRAIL_BLOCKED"
        assert "personal information" in events[0]["data"]["message"].lower()


@pytest.mark.asyncio
async def test_ingress_guardrail_safety_blocked_yields_guardrail_blocked_event(monkeypatch):
    """Guardrail safety violation yields SSE GUARDRAIL_BLOCKED ErrorEvent."""
    token = make_jwt()
    mock_gr = MagicMock()
    mock_gr.validate_message = AsyncMock(return_value=(False, "Harmful prompt detected"))
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.post(
            "/chat/stream",
            json={"message": "generate harmful instructions"},
            headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
        )
        assert response.status_code == 200

        lines = [line async for line in response.aiter_lines()]
        events = parse_sse(lines)

        assert len(events) == 1
        assert events[0]["event"] == "error"
        assert events[0]["data"]["code"] == "GUARDRAIL_BLOCKED"
        assert events[0]["data"]["message"] == "Your message could not be processed."


def test_ingress_guardrail_unavailable_raises_503(monkeypatch):
    """Guardrail service unavailable raises 503 HTTP status."""
    token = make_jwt()
    mock_gr = MagicMock()
    mock_gr.validate_message = AsyncMock(
        return_value=(False, "NeMo guardrail service is unavailable")
    )
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)

    response = client.post(
        "/chat/stream",
        json={"message": "hello agent"},
        headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
    )
    assert response.status_code == 503
    assert "Safety check unavailable" in response.json().get("detail", "")


# ===========================================================================
# 5. Streaming response formatting & ChatTurnRunner delegation
# ===========================================================================


@pytest.mark.asyncio
async def test_streaming_event_serialization_wire_format(mock_nestjs_client, monkeypatch):
    """Verify event serialization to SSE wire format for all event types:
    token, tool_call, tool_result, flight_results, ACTION_HANDOFF, ACTION_REQUIRED, done, error.
    """
    token = make_jwt()

    mock_events = [
        TokenEvent(data=TokenPayload(content="Hello world")),
        ToolCallEvent(
            data=ToolCallPayload(
                name="search_flights", inputs={"origin": "HAN", "destination": "SGN"}
            )
        ),
        ToolResultEvent(
            data=ToolResultPayload(name="search_flights", result="Found 3 available flights")
        ),
        FlightResultsEvent(
            data=FlightResultsPayload(
                results=[
                    {
                        "flightOfferId": "offer-1",
                        "airline": "VN",
                        "flightNumber": "VN310",
                        "price": "150.00",
                    }
                ]
            )
        ),
        ActionHandoffEvent(
            data=ActionHandoffPayload(
                version=1,
                action="begin_checkout",
                handoffToken="chk_tok_1234567890",
                expiresAt="2026-12-31T23:59:59Z",
                display={"airline": "VN", "price": "150.00"},
            )
        ),
        ActionRequiredEvent(
            data=ActionRequiredPayload(
                action="COMPLETE_PROFILE",
                target="/profile",
                scope="DOMESTIC",
                passengers=[],
            )
        ),
        DoneEvent(data=DonePayload(messageId="msg-final-123", sessionId="sess-test-123")),
        ErrorEvent(
            data=ErrorPayload(
                code="LLM_ERROR",
                message="AI model execution failure",
                partialMessageId="msg-final-123",
            )
        ),
    ]

    async def mock_run_generator(command):
        for ev in mock_events:
            yield ev

    mock_runner = MagicMock()
    mock_runner.run = mock_run_generator

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.streaming.sse.ChatTurnRunner", return_value=mock_runner),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "test all event types", "sessionId": "sess-test-123"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )
            assert response.status_code == 200

            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)

            # Check all 8 events are serialized and parsed with exact structure
            assert len(events) == 8

            # 1. token
            assert events[0]["event"] == "token"
            assert events[0]["data"] == {"content": "Hello world"}

            # 2. tool_call
            assert events[1]["event"] == "tool_call"
            assert events[1]["data"] == {
                "name": "search_flights",
                "inputs": {"origin": "HAN", "destination": "SGN"},
            }

            # 3. tool_result
            assert events[2]["event"] == "tool_result"
            assert events[2]["data"] == {
                "name": "search_flights",
                "result": "Found 3 available flights",
            }

            # 4. flight_results
            assert events[3]["event"] == "flight_results"
            assert events[3]["data"]["results"][0]["flightOfferId"] == "offer-1"
            assert events[3]["data"]["results"][0]["price"] == "150.00"

            # 5. ACTION_HANDOFF
            assert events[4]["event"] == "ACTION_HANDOFF"
            assert events[4]["data"]["action"] == "begin_checkout"
            assert events[4]["data"]["handoffToken"] == "chk_tok_1234567890"
            assert events[4]["data"]["display"]["airline"] == "VN"

            # 6. ACTION_REQUIRED
            assert events[5]["event"] == "ACTION_REQUIRED"
            assert events[5]["data"]["action"] == "COMPLETE_PROFILE"
            assert events[5]["data"]["target"] == "/profile"

            # 7. done
            assert events[6]["event"] == "done"
            assert events[6]["data"]["messageId"] == "msg-final-123"
            assert events[6]["data"]["sessionId"] == "sess-test-123"

            # 8. error
            assert events[7]["event"] == "error"
            assert events[7]["data"]["code"] == "LLM_ERROR"
            assert events[7]["data"]["message"] == "AI model execution failure"
            assert events[7]["data"]["partialMessageId"] == "msg-final-123"


@pytest.mark.asyncio
async def test_chat_turn_runner_instantiation_and_command_delegation(
    mock_nestjs_client, monkeypatch
):
    """Verify ChatTurnRunner is instantiated with dependencies and command is passed accurately."""
    token = make_jwt(sub="user-delegation-456")
    captured_command = None
    runner_init_kwargs = None

    class MockChatTurnRunner:
        def __init__(self, **kwargs):
            nonlocal runner_init_kwargs
            runner_init_kwargs = kwargs

        async def run(self, command: ChatTurnCommand):
            nonlocal captured_command
            captured_command = command
            yield TokenEvent(data=TokenPayload(content="Hi"))
            yield DoneEvent(data=DonePayload(sessionId=command.session_id))

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.streaming.sse.ChatTurnRunner", MockChatTurnRunner),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "book flight", "sessionId": "sess-custom-789"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Origin": "http://localhost:3000",
                    "X-Trace-Id": "chat_0123456789abcdef0123456789abcdef",
                    "X-Correlation-Id": "chat_fedcba9876543210fedcba9876543210",
                },
            )
            assert response.status_code == 200
            _ = [line async for line in response.aiter_lines()]

            # Verify runner instantiation kwargs
            assert runner_init_kwargs is not None
            assert "settings" in runner_init_kwargs
            assert "graph" in runner_init_kwargs
            assert "guardrails" in runner_init_kwargs
            assert "queue_manager" in runner_init_kwargs
            assert "redis_client" in runner_init_kwargs
            assert runner_init_kwargs["client_factory"] is not None
            assert runner_init_kwargs["client_factory"]() == mock_nestjs_client

            # Verify command attributes
            assert captured_command is not None
            assert captured_command.user_id == "user-delegation-456"
            assert captured_command.session_id == "sess-custom-789"
            assert captured_command.message == "book flight"
            assert captured_command.token == token
            assert captured_command.trace_id == "chat_0123456789abcdef0123456789abcdef"
            assert captured_command.correlation_id == "chat_fedcba9876543210fedcba9876543210"


# ===========================================================================
# 6. Active runner tracking
# ===========================================================================


@pytest.mark.asyncio
async def test_active_runner_tracked_during_stream_and_removed_on_completion(mock_nestjs_client):
    """Stream task is added to active_runners during streaming and removed on completion."""
    token = make_jwt()
    active_runner_count_during_stream = []

    async def mock_tracking_run(command):
        # Sample active_runners set while inside generator execution
        active_runner_count_during_stream.append(len(active_runners))
        yield TokenEvent(data=TokenPayload(content="streaming token"))
        yield DoneEvent(data=DonePayload(sessionId="sess-123"))

    mock_runner = MagicMock()
    mock_runner.run = mock_tracking_run

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.streaming.sse.ChatTurnRunner", return_value=mock_runner),
    ):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "track runner"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )
            assert response.status_code == 200
            lines = [line async for line in response.aiter_lines()]
            assert len(lines) > 0

        # While streaming, active_runners was non-empty
        assert len(active_runner_count_during_stream) == 1
        assert active_runner_count_during_stream[0] >= 1

        # After stream completes, active_runners is emptied
        assert len(active_runners) == 0


# ===========================================================================
# 7. Client disconnect
# ===========================================================================


@pytest.mark.asyncio
async def test_client_disconnect_triggers_aclose_and_runner_cleanup(mock_nestjs_client):
    """Client disconnect triggers generator.aclose() and runner cleanup."""
    token = make_jwt()
    generator_closed = False

    async def mock_disconnectable_run(command):
        nonlocal generator_closed
        try:
            yield TokenEvent(data=TokenPayload(content="token 1"))
            yield TokenEvent(data=TokenPayload(content="token 2"))
            yield DoneEvent(data=DonePayload(sessionId="sess-123"))
        finally:
            generator_closed = True

    mock_runner = MagicMock()
    mock_runner.run = mock_disconnectable_run

    with (
        patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
        patch("agent.streaming.sse.ChatTurnRunner", return_value=mock_runner),
    ):
        transport = httpx.ASGITransport(app=app)
        # Mock request.is_disconnected to simulate client disconnecting after first token
        with patch(
            "starlette.requests.Request.is_disconnected",
            AsyncMock(side_effect=[False, True, True]),
        ):
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={"message": "disconnect test"},
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Origin": "http://localhost:3000",
                    },
                )
                assert response.status_code == 200
                _ = [line async for line in response.aiter_lines()]

        # Generator must be closed cleanly via aclose() in finally block
        assert generator_closed is True
        assert len(active_runners) == 0


# ===========================================================================
# 8. Server shutdown
# ===========================================================================


@pytest.mark.asyncio
async def test_server_shutdown_cancels_and_awaits_active_runners(monkeypatch):
    """active_runners tasks are cancelled and awaited during lifespan shutdown."""
    monkeypatch.setattr("agent.infrastructure.redis.init_redis", AsyncMock())
    monkeypatch.setattr("agent.infrastructure.redis.close_redis", AsyncMock())
    monkeypatch.setattr("agent.guardrails.nemo.NemoGuardrailService.probe", AsyncMock())

    cancelled = False

    async def mock_runner_task():
        nonlocal cancelled
        try:
            await asyncio.sleep(100)
        except asyncio.CancelledError:
            cancelled = True
            raise

    task = asyncio.create_task(mock_runner_task())
    await asyncio.sleep(0)
    active_runners.add(task)

    assert not task.done()
    assert task in active_runners

    async with lifespan(app):
        pass

    assert task.cancelled() or task.done()
    assert cancelled is True
    assert len(active_runners) == 0


@pytest.mark.asyncio
async def test_server_shutdown_awaits_slow_cancellation_cleanup_before_closing_redis(monkeypatch):
    """Ensure runner cancellation cleanup executes and finishes BEFORE close_redis is called."""
    cleanup_finished = False
    redis_closed_after_cleanup = False

    async def mock_close_redis():
        nonlocal redis_closed_after_cleanup
        # At the moment Redis is closed, cleanup MUST already be finished
        redis_closed_after_cleanup = cleanup_finished

    monkeypatch.setattr("agent.infrastructure.redis.init_redis", AsyncMock())
    monkeypatch.setattr("agent.infrastructure.redis.close_redis", mock_close_redis)
    monkeypatch.setattr("agent.guardrails.nemo.NemoGuardrailService.probe", AsyncMock())

    async def mock_runner_task_with_cleanup():
        nonlocal cleanup_finished
        try:
            await asyncio.sleep(100)
        except asyncio.CancelledError:
            # Simulate async cleanup (persisting partial response or releasing lock)
            await asyncio.sleep(0.05)
            cleanup_finished = True
            raise

    task = asyncio.create_task(mock_runner_task_with_cleanup())
    await asyncio.sleep(0)
    active_runners.add(task)

    async with lifespan(app):
        pass

    assert task.cancelled() or task.done()
    assert cleanup_finished is True
    assert redis_closed_after_cleanup is True
    assert len(active_runners) == 0


@pytest.mark.asyncio
async def test_server_shutdown_does_not_hang_indefinitely_on_stuck_runner(monkeypatch):
    """Ensure shutdown does not hang indefinitely if a runner task is completely unyielding."""
    monkeypatch.setattr("agent.infrastructure.redis.init_redis", AsyncMock())
    monkeypatch.setattr("agent.infrastructure.redis.close_redis", AsyncMock())
    monkeypatch.setattr("agent.guardrails.nemo.NemoGuardrailService.probe", AsyncMock())
    monkeypatch.setattr("agent.main.settings.SHUTDOWN_TIMEOUT_SECONDS", 0.1, raising=False)

    async def mock_stuck_runner_task():
        try:
            await asyncio.sleep(100)
        except asyncio.CancelledError:
            # Simulate an uncooperative/shielded task that takes longer than shutdown timeout
            await asyncio.sleep(10)

    task = asyncio.create_task(mock_stuck_runner_task())
    await asyncio.sleep(0)
    active_runners.add(task)

    try:
        # Lifespan shutdown must finish cleanly within ~0.2s without hanging
        async with asyncio.timeout(1.0):
            async with lifespan(app):
                pass
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    assert len(active_runners) == 0
