"""
Characterization and Unit Test Suite for Admission Ordering and Guardrails.
Feature 027 Phase 5 - Slice 1 (Tasks T016 - T021).

Scenarios covered:
1. Strict Ordering Assertion:
   Verify invocation order is strictly AuthService -> InputAdmissionService
   (length + gateway health + input scan) -> QuotaService.
2. Gateway Unavailable (503):
   Unhealthy or missing gateway raises HTTP 503 before any input scan or quota check.
3. PII Ingress Short-Circuit (Zero Redis / Zero Quota):
   Blocked PII input returns canonical single SSE error event with zero Redis calls
   and zero quota deduction.
4. Invalid Length (400):
   Prompt exceeding MAX_MESSAGE_LENGTH raises HTTP 400 before gateway scan or quota check.
5. Deterministic Inactive User (401):
   Inactive user account or revoked token from NestJS access check raises HTTP 401
   before message scan or quota check.
6. Single-Scan Guarantee:
   Input validated once during admission; ChatController forwards validated input
   to runner without re-scanning.

Supports testing both current FastAPI endpoint `/chat/stream` and modular
`agent.admission` services (or fallback mock harness before extraction).
"""

import json
import time
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.controller import ChatController
from agent.chat_turn.events import (
    DoneEvent,
    DonePayload,
    TokenEvent,
    TokenPayload,
)
from agent.config import get_settings
from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_INPUT_PII,
    AdmissionContext,
    PipelineDecision,
    ValidatedInput,
)
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.pii import deterministic_pii_match
from agent.infrastructure.redis import get_redis_client
from agent.main import app
from agent.observability.chat_observability import safe_opaque_id
from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    ChatBudgetRepository,
    RedisUnavailableException,
)
from agent.tools.nestjs_client import NestJSClient

settings = get_settings()
client = TestClient(app)

# ---------------------------------------------------------------------------
# Module import or fallback mock harness for future agent.admission modules
# (Slice 1 Tasks T017-T019)
# ---------------------------------------------------------------------------
try:
    from agent.admission.auth import AuthenticatedUser, AuthService
except ImportError:
    from dataclasses import dataclass

    @dataclass(frozen=True)
    class AuthenticatedUser:
        user_id: str
        token: str
        trace_id: str
        correlation_id: str
        jti: Optional[str] = None

    class AuthService:  # type: ignore[no-redef]
        """Target contract harness for agent.admission.auth.AuthService (Task T017)."""

        def __init__(self, settings: Any = None, client_factory: Any = None):
            self.settings = settings or get_settings()
            self.client_factory = client_factory or NestJSClient

        async def authenticate(
            self,
            authorization: Optional[str],
            x_trace_id: Optional[str] = None,
            x_correlation_id: Optional[str] = None,
        ) -> AuthenticatedUser:
            if not authorization or not authorization.startswith("Bearer "):
                raise HTTPException(status_code=401, detail="Invalid authorization header")
            token = authorization.split(" ", 1)[1]
            from agent.utils.auth import decode_and_verify_jwt

            issuer = getattr(self.settings, "JWT_ISSUER", "booking-systems-api")
            audience = getattr(self.settings, "JWT_AUDIENCE", "booking-systems-clients")
            secrets_to_try = (
                self.settings.jwt_secret_ring
                if hasattr(self.settings, "jwt_secret_ring")
                else self.settings.JWT_SECRET
            )
            try:
                payload = decode_and_verify_jwt(
                    token=token,
                    secret=secrets_to_try,
                    issuer=issuer,
                    audience=audience,
                )
                user_id = str(payload.get("sub") or payload.get("id") or "")
                jti = payload.get("jti")
            except Exception as err:
                raise HTTPException(status_code=401, detail="Invalid token") from err

            trace_id = safe_opaque_id(x_trace_id)
            correlation_id = safe_opaque_id(x_correlation_id)
            nest_client = self.client_factory(
                base_url=self.settings.NESTJS_API_URL,
                token=token,
                trace_id=trace_id,
                correlation_id=correlation_id,
            )
            access_res = await nest_client.check_user_access(sub=user_id, jti=jti)
            if not access_res.get("allowed"):
                raise HTTPException(
                    status_code=401, detail="User account inactive or token revoked"
                )

            return AuthenticatedUser(
                user_id=user_id,
                token=token,
                trace_id=trace_id,
                correlation_id=correlation_id,
                jti=jti,
            )


try:
    from agent.admission.input_admission import (
        InputAdmissionResult,
        InputAdmissionService,
        create_blocked_sse_response,
    )

    HAS_INPUT_ADMISSION_MODULE = True
except ImportError:
    HAS_INPUT_ADMISSION_MODULE = False
    from dataclasses import dataclass

    @dataclass
    class InputAdmissionResult:
        decision: PipelineDecision
        validated_input: Optional[ValidatedInput] = None
        blocked_event: Optional[Any] = None

        @property
        def is_blocked(self) -> bool:
            return self.decision.status == "BLOCK"

    class InputAdmissionService:  # type: ignore[no-redef]
        """Target contract harness for agent.admission.input_admission.InputAdmissionService (Task T018)."""

        def __init__(self, settings: Any = None):
            self.settings = settings or get_settings()

        async def admit_input(
            self,
            message: Optional[str],
            session_id: Optional[str],
            user: AuthenticatedUser,
            gateway: Optional[GuardrailGateway],
        ) -> InputAdmissionResult:
            if message and len(message) > self.settings.MAX_MESSAGE_LENGTH:
                raise HTTPException(status_code=400, detail="Message exceeds maximum length")
            if (
                gateway is None
                or not isinstance(gateway, GuardrailGateway)
                or not gateway.is_healthy()
            ):
                raise HTTPException(
                    status_code=503,
                    detail="GUARDRAIL_GATEWAY_UNAVAILABLE: Guardrail gateway is uninitialized or degraded",
                )
            if not message:
                return InputAdmissionResult(
                    decision=PipelineDecision(status="PASS", validated_data=None),
                    validated_input=None,
                )

            context = AdmissionContext(
                user_id=user.user_id,
                chat_session_id=session_id or "unassigned",
                trace_id=user.trace_id,
                correlation_id=user.correlation_id,
                policy_version="2026-09-05",
            )
            try:
                decision = await gateway.validate_input(context, message)
            except Exception:
                decision = PipelineDecision(
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_INJECTION,
                    reason="Input validation failed closed",
                )
            if not isinstance(decision, PipelineDecision):
                if deterministic_pii_match(message):
                    decision = PipelineDecision(
                        status="BLOCK",
                        response_key=GUARDRAIL_INPUT_PII,
                        reason="PII detected",
                    )
                else:
                    decision = PipelineDecision(
                        status="PASS",
                        validated_data=ValidatedInput(content=message),
                    )

            if decision.status == "BLOCK":
                return InputAdmissionResult(
                    decision=decision,
                    validated_input=None,
                )
            return InputAdmissionResult(
                decision=decision,
                validated_input=decision.validated_data,
            )


try:
    from agent.admission.quota import QuotaService

    HAS_QUOTA_MODULE = True
except ImportError:
    HAS_QUOTA_MODULE = False
    QuotaService = None  # type: ignore[assignment, misc]

HAS_ADMISSION_MODULES = HAS_INPUT_ADMISSION_MODULE and HAS_QUOTA_MODULE


# ---------------------------------------------------------------------------
# Test Helpers
# ---------------------------------------------------------------------------
def make_jwt(
    sub: str = "user-123",
    jti: str = "jti-uuid-456",
    iss: Optional[str] = None,
    aud: Optional[str] = None,
    exp: Optional[int] = None,
    secret: Optional[str] = None,
    extra: Optional[dict] = None,
) -> str:
    """Generate canonical test JWT."""
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


def parse_sse(lines: list[str]) -> list[dict]:
    """Parse raw SSE line output into structured events."""
    events = []
    current: dict = {}
    for raw in lines:
        line = raw.decode("utf-8").strip() if isinstance(raw, bytes) else raw.strip()
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture
def mock_nestjs_client():
    client_mock = MagicMock(spec=NestJSClient)
    client_mock.check_user_access = AsyncMock(return_value={"allowed": True})
    return client_mock


@pytest.fixture
def mock_gateway(monkeypatch):
    gw = MagicMock(spec=GuardrailGateway)
    gw.is_healthy.return_value = True
    gw.validate_input = AsyncMock(
        return_value=PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content="safe input"),
        )
    )
    monkeypatch.setattr(app.state, "guardrail_gateway", gw, raising=False)
    return gw


@pytest.fixture
def mock_runner():
    runner = MagicMock()

    async def mock_run(command, validated_input=None):
        yield TokenEvent(data=TokenPayload(content="Response token"))
        yield DoneEvent(data=DonePayload(sessionId=command.session_id or "sess-default"))

    runner.run = MagicMock(side_effect=mock_run)
    return runner


# ===========================================================================
# Section 1: Endpoint Characterization Suite (/chat/stream)
# ===========================================================================
class TestChatStreamAdmissionEndpoint:
    """End-to-end characterization of admission order and short-circuits on /chat/stream."""

    def test_strict_ordering_auth_then_input_then_quota(
        self,
        mock_nestjs_client: MagicMock,
        mock_gateway: MagicMock,
        mock_runner: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """
        Scenario 1: Strict Ordering Assertion.
        Invocation order must strictly be AuthService -> InputAdmissionService
        (length + gateway health + input scan) -> QuotaService -> Runner.
        """
        call_order: list[str] = []

        async def spy_access(*args, **kwargs):
            call_order.append("auth")
            return {"allowed": True}

        def spy_health():
            call_order.append("gateway_health")
            return True

        async def spy_validate(context, message):
            call_order.append("input_scan")
            return PipelineDecision(
                status="PASS",
                validated_data=ValidatedInput(content=message),
            )

        async def spy_quota(*args, **kwargs):
            call_order.append("quota")
            return True

        mock_nestjs_client.check_user_access = AsyncMock(side_effect=spy_access)
        mock_gateway.is_healthy = MagicMock(side_effect=spy_health)
        mock_gateway.validate_input = AsyncMock(side_effect=spy_validate)

        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(side_effect=spy_quota)

        async def spy_run(command, validated_input=None):
            call_order.append("runner")
            yield TokenEvent(data=TokenPayload(content="token"))
            yield DoneEvent(data=DonePayload(sessionId=command.session_id or "sess-1"))

        mock_runner.run = MagicMock(side_effect=spy_run)

        token = make_jwt()
        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
            patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
            patch("agent.streaming.sse.ChatTurnRunner", return_value=mock_runner),
        ):
            response = client.post(
                "/chat/stream",
                json={"message": "Strict progression test", "sessionId": "sess-order-1"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )

            assert response.status_code == 200
            events = parse_sse(response.text.splitlines())
            assert len(events) == 2

            # Assert complete and strict invocation order
            assert call_order == ["auth", "gateway_health", "input_scan", "quota", "runner"]
            assert call_order.index("auth") < call_order.index("gateway_health")
            assert call_order.index("gateway_health") < call_order.index("input_scan")
            assert call_order.index("input_scan") < call_order.index("quota")
            assert call_order.index("quota") < call_order.index("runner")

    def test_gateway_unavailable_raises_503_before_scan_or_quota(
        self,
        mock_nestjs_client: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """
        Scenario 2: Gateway Unavailable (503).
        Unhealthy or missing gateway raises HTTP 503 before any input scan or quota check.
        """
        token = make_jwt()
        mock_redis = MagicMock()
        mock_budget = MagicMock()

        # Case 2A: Degraded / unhealthy gateway
        degraded_gw = MagicMock(spec=GuardrailGateway)
        degraded_gw.is_healthy.return_value = False
        degraded_gw.validate_input = AsyncMock()
        monkeypatch.setattr(app.state, "guardrail_gateway", degraded_gw, raising=False)

        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.get_redis_client", mock_redis),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        ):
            response_degraded = client.post(
                "/chat/stream",
                json={"message": "Valid prompt to degraded gateway"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )
            assert response_degraded.status_code == 503
            assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in response_degraded.json().get("detail", "")
            assert degraded_gw.validate_input.call_count == 0
            assert mock_budget.admit_request.call_count == 0
            assert mock_redis.call_count == 0

        # Case 2B: Missing gateway (None)
        monkeypatch.setattr(app.state, "guardrail_gateway", None, raising=False)
        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.get_redis_client", mock_redis),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        ):
            response_missing = client.post(
                "/chat/stream",
                json={"message": "Valid prompt with missing gateway"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )
            assert response_missing.status_code == 503
            assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in response_missing.json().get("detail", "")
            assert mock_budget.admit_request.call_count == 0
            assert mock_redis.call_count == 0

    def test_pii_ingress_short_circuit_zero_redis_zero_quota(
        self,
        mock_nestjs_client: MagicMock,
        mock_gateway: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """
        Scenario 3: PII Ingress Short-Circuit (Zero Redis / Zero Quota).
        Blocked PII input returns canonical single SSE error event with zero Redis calls
        and zero quota deduction.
        """
        token = make_jwt()
        mock_gateway.validate_input = AsyncMock(
            return_value=PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_PII,
                reason="PII detected in user message",
            )
        )

        mock_redis = MagicMock()
        mock_budget = MagicMock()

        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.get_redis_client", mock_redis),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        ):
            response = client.post(
                "/chat/stream",
                json={"message": "My SSN is 123-45-6789 and email user@example.com"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )

            # Returns 200 SSE stream with canonical error event
            assert response.status_code == 200
            assert "text/event-stream" in response.headers.get("content-type", "")

            events = parse_sse(response.text.splitlines())
            assert len(events) == 1
            assert events[0]["event"] == "error"
            assert events[0]["data"]["code"] == "GUARDRAIL_BLOCKED"
            assert (
                events[0]["data"]["message"]
                == "Your message contains protected personal information and cannot be processed."
            )
            assert events[0]["data"]["partialMessageId"] is None

            # Assert ZERO Redis interaction and ZERO quota check calls
            assert mock_redis.call_count == 0
            assert mock_budget.admit_request.call_count == 0

    def test_invalid_length_raises_400_before_gateway_scan_or_quota(
        self,
        mock_nestjs_client: MagicMock,
        mock_gateway: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """
        Scenario 4: Invalid Length (400).
        Prompt exceeding MAX_MESSAGE_LENGTH raises HTTP 400 before gateway scan or quota check.
        """
        token = make_jwt()
        max_len = 50
        monkeypatch.setattr(settings, "MAX_MESSAGE_LENGTH", max_len)

        mock_redis = MagicMock()
        mock_budget = MagicMock()

        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.get_redis_client", mock_redis),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        ):
            long_message = "A" * (max_len + 1)
            response = client.post(
                "/chat/stream",
                json={"message": long_message},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )

            assert response.status_code == 400
            assert "exceeds maximum length" in response.json().get("detail", "")
            # Assert gateway health, input scan, and quota were never invoked
            assert mock_gateway.is_healthy.call_count == 0
            assert mock_gateway.validate_input.call_count == 0
            assert mock_budget.admit_request.call_count == 0
            assert mock_redis.call_count == 0

    def test_deterministic_inactive_user_raises_401_before_scan_or_quota(
        self,
        mock_nestjs_client: MagicMock,
        mock_gateway: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """
        Scenario 5: Deterministic Inactive User (401).
        Inactive user account or revoked token from NestJS access check raises HTTP 401
        before message scan or quota check.
        """
        token = make_jwt()
        mock_nestjs_client.check_user_access = AsyncMock(return_value={"allowed": False})

        mock_redis = MagicMock()
        mock_budget = MagicMock()

        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.get_redis_client", mock_redis),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
        ):
            response = client.post(
                "/chat/stream",
                json={"message": "Safe prompt from revoked user"},
                headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
            )

            assert response.status_code == 401
            assert "inactive or token revoked" in response.json().get("detail", "").lower()
            # Assert gateway health, input scan, and quota were never reached
            assert mock_gateway.is_healthy.call_count == 0
            assert mock_gateway.validate_input.call_count == 0
            assert mock_budget.admit_request.call_count == 0
            assert mock_redis.call_count == 0

    @pytest.mark.asyncio
    async def test_single_scan_guarantee_end_to_end(
        self,
        mock_nestjs_client: MagicMock,
        mock_gateway: MagicMock,
        mock_runner: MagicMock,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """
        Scenario 6: Single-Scan Guarantee.
        Input validated once during admission; ChatController forwards validated input
        to runner without re-scanning.
        """
        token = make_jwt()
        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(return_value=True)

        with (
            patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client),
            patch("agent.streaming.sse.ChatBudgetRepository", return_value=mock_budget),
            patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
            patch("agent.streaming.sse.ChatTurnRunner", return_value=mock_runner),
        ):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
                response = await ac.post(
                    "/chat/stream",
                    json={"message": "Flight search request", "sessionId": "sess-scan-1"},
                    headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
                )

                assert response.status_code == 200
                lines = [line async for line in response.aiter_lines()]
                events = parse_sse(lines)
                assert len(events) == 2
                assert events[0]["event"] == "token"
                assert events[1]["event"] == "done"

                # Gateway validate_input was called exactly ONCE across the entire lifecycle
                assert mock_gateway.validate_input.call_count == 1


# ===========================================================================
# Section 2: Modular Admission Service Suite & Fallback Harness
# ===========================================================================
class TestModularAdmissionServiceSuite:
    """
    Tests the modular admission service chain contracts (AuthService ->
    InputAdmissionService -> QuotaService) directly.
    Runs against agent.admission if extracted, or the canonical fallback harness.
    """

    @pytest.mark.asyncio
    async def test_modular_strict_ordering_chain(self):
        """Verify modular admission services execute in strict order."""
        auth_service = AuthService()
        input_service = InputAdmissionService()
        quota_service = QuotaService()

        call_order: list[str] = []

        mock_nest = MagicMock(spec=NestJSClient)

        async def spy_access(*args, **kwargs):
            call_order.append("auth")
            return {"allowed": True}

        mock_nest.check_user_access = AsyncMock(side_effect=spy_access)
        auth_service.client_factory = MagicMock(return_value=mock_nest)

        mock_gw = MagicMock(spec=GuardrailGateway)

        def spy_health():
            call_order.append("gateway_health")
            return True

        async def spy_validate(*args, **kwargs):
            call_order.append("input_scan")
            return PipelineDecision(
                status="PASS",
                validated_data=ValidatedInput(content="Test message"),
            )

        mock_gw.is_healthy = MagicMock(side_effect=spy_health)
        mock_gw.validate_input = AsyncMock(side_effect=spy_validate)

        mock_redis = MagicMock()
        mock_budget = MagicMock()

        async def spy_admit(*args, **kwargs):
            call_order.append("quota")
            return True

        mock_budget.admit_request = AsyncMock(side_effect=spy_admit)
        quota_service.redis_client_factory = MagicMock(return_value=mock_redis)
        if hasattr(quota_service, "budget_repo_factory"):
            quota_service.budget_repo_factory = MagicMock(return_value=mock_budget)

        patches = [
            patch(
                "agent.repositories.chat_budget_repository.ChatBudgetRepository",
                return_value=mock_budget,
            )
        ]
        if HAS_ADMISSION_MODULES:
            patches.append(patch("agent.admission.quota.ChatBudgetRepository", mock_budget))

        with patches[0]:
            if len(patches) > 1:
                with patches[1]:
                    token = make_jwt(sub="user-mod-1")
                    user = await auth_service.authenticate(f"Bearer {token}")
                    assert user.user_id == "user-mod-1"

                    admitted = await input_service.admit_input(
                        message="Test message",
                        session_id="sess-mod-1",
                        user=user,
                        gateway=mock_gw,
                    )
                    assert admitted.decision.status == "PASS"

                    await quota_service.check_quota(
                        user_id=user.user_id,
                        trace_id=user.trace_id,
                        correlation_id=user.correlation_id,
                    )
                    assert call_order == ["auth", "gateway_health", "input_scan", "quota"]
            else:
                token = make_jwt(sub="user-mod-1")
                user = await auth_service.authenticate(f"Bearer {token}")
                assert user.user_id == "user-mod-1"

                admitted = await input_service.admit_input(
                    message="Test message",
                    session_id="sess-mod-1",
                    user=user,
                    gateway=mock_gw,
                )
                assert admitted.decision.status == "PASS"

                await quota_service.check_quota(
                    user_id=user.user_id,
                    trace_id=user.trace_id,
                    correlation_id=user.correlation_id,
                )
                assert call_order == ["auth", "gateway_health", "input_scan", "quota"]
        return

    @pytest.mark.asyncio
    async def test_modular_gateway_unavailable_raises_503(self):
        """Unhealthy gateway in InputAdmissionService raises 503 before scan or quota."""
        input_service = InputAdmissionService()
        mock_gw = MagicMock(spec=GuardrailGateway)
        mock_gw.is_healthy.return_value = False
        mock_gw.validate_input = AsyncMock()

        user = AuthenticatedUser(
            user_id="user-1",
            token="tok",
            trace_id="tr-1",
            correlation_id="cor-1",
        )

        with pytest.raises(HTTPException) as exc_info:
            await input_service.admit_input(
                message="Hello",
                session_id="sess-1",
                user=user,
                gateway=mock_gw,
            )
        assert exc_info.value.status_code == 503
        assert "GUARDRAIL_GATEWAY_UNAVAILABLE" in exc_info.value.detail
        assert mock_gw.validate_input.call_count == 0

    @pytest.mark.asyncio
    async def test_modular_pii_short_circuit_returns_block(self):
        """PII message in InputAdmissionService produces BLOCK decision for zero quota."""
        input_service = InputAdmissionService()
        mock_gw = MagicMock(spec=GuardrailGateway)
        mock_gw.is_healthy.return_value = True
        mock_gw.validate_input = AsyncMock(
            return_value=PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_PII,
                reason="PII detected",
            )
        )

        user = AuthenticatedUser(
            user_id="user-1",
            token="tok",
            trace_id="tr-1",
            correlation_id="cor-1",
        )

        result = await input_service.admit_input(
            message="My SSN is 000-00-0000",
            session_id="sess-1",
            user=user,
            gateway=mock_gw,
        )

        assert result.decision.status == "BLOCK"
        assert result.decision.response_key == GUARDRAIL_INPUT_PII
        assert result.validated_input is None

    @pytest.mark.asyncio
    async def test_modular_invalid_length_raises_400(self, monkeypatch: pytest.MonkeyPatch):
        """Message exceeding limit in InputAdmissionService raises 400 before scan."""
        monkeypatch.setattr(settings, "MAX_MESSAGE_LENGTH", 20)
        input_service = InputAdmissionService(settings=settings)
        mock_gw = MagicMock(spec=GuardrailGateway)
        mock_gw.is_healthy = MagicMock()
        mock_gw.validate_input = AsyncMock()

        user = AuthenticatedUser(
            user_id="user-1",
            token="tok",
            trace_id="tr-1",
            correlation_id="cor-1",
        )

        with pytest.raises(HTTPException) as exc_info:
            await input_service.admit_input(
                message="This message is longer than twenty characters",
                session_id="sess-1",
                user=user,
                gateway=mock_gw,
            )
        assert exc_info.value.status_code == 400
        assert "exceeds maximum length" in exc_info.value.detail
        assert mock_gw.is_healthy.call_count == 0
        assert mock_gw.validate_input.call_count == 0

    @pytest.mark.asyncio
    async def test_modular_inactive_user_raises_401(self):
        """Inactive user in AuthService raises 401."""
        auth_service = AuthService()
        mock_nest = MagicMock(spec=NestJSClient)
        mock_nest.check_user_access = AsyncMock(return_value={"allowed": False})
        auth_service.client_factory = MagicMock(return_value=mock_nest)

        token = make_jwt(sub="inactive-user")
        with pytest.raises(HTTPException) as exc_info:
            await auth_service.authenticate(f"Bearer {token}")
        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == "User account inactive or token revoked"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "invalid_header",
        [
            None,
            "",
            "Basic 12345",
            "Bearer",
            "bearer abc",
            "Token abc",
        ],
    )
    async def test_modular_invalid_authorization_header_raises_401(self, invalid_header):
        """Missing or non-Bearer authorization header raises HTTP 401."""
        auth_service = AuthService()
        with pytest.raises(HTTPException) as exc_info:
            await auth_service.authenticate(invalid_header)
        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == "Invalid authorization header"

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "bad_token",
        [
            "not-a-jwt",
            "header.payload",
            make_jwt(secret="wrong-secret-key-that-does-not-match"),
            make_jwt(exp=int(time.time()) - 3600),
        ],
    )
    async def test_modular_bad_token_raises_401(self, bad_token):
        """Malformed, invalid-signature, or expired tokens raise HTTP 401."""
        auth_service = AuthService()
        with pytest.raises(HTTPException) as exc_info:
            await auth_service.authenticate(f"Bearer {bad_token}")
        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == "Invalid token"

    @pytest.mark.asyncio
    async def test_modular_auth_service_success_returns_authenticated_user(self):
        """Valid token and active user returns AuthenticatedUser with trace and correlation."""
        auth_service = AuthService()
        mock_nest = MagicMock(spec=NestJSClient)
        mock_nest.check_user_access = AsyncMock(return_value={"allowed": True})
        auth_service.client_factory = MagicMock(return_value=mock_nest)

        token = make_jwt(sub="user-valid-999", jti="jti-test-999")
        trace_id = "chat_" + "a" * 32
        correlation_id = "chat_" + "b" * 32
        user = await auth_service.authenticate(
            f"Bearer {token}",
            x_trace_id=trace_id,
            x_correlation_id=correlation_id,
        )

        assert isinstance(user, AuthenticatedUser)
        assert user.user_id == "user-valid-999"
        assert user.token == token
        assert user.jti == "jti-test-999"
        assert user.trace_id == trace_id
        assert user.correlation_id == correlation_id

        # Verify AuthenticatedUser is frozen
        with pytest.raises(Exception):
            user.user_id = "attempted-mutation"  # type: ignore[misc]

    @pytest.mark.asyncio
    async def test_modular_single_scan_guarantee_forwarding(self):
        """
        Verify InputAdmissionResult decision passed to ChatController.stream
        forwards validated_input to runner without re-scanning gateway.
        """
        input_service = InputAdmissionService()
        mock_gw = MagicMock(spec=GuardrailGateway)
        mock_gw.is_healthy.return_value = True
        mock_gw.validate_input = AsyncMock(
            return_value=PipelineDecision(
                status="PASS",
                validated_data=ValidatedInput(content="Admitted query"),
            )
        )

        user = AuthenticatedUser(
            user_id="user-single-scan",
            token="test-token",
            trace_id="tr-scan",
            correlation_id="cor-scan",
        )

        # 1. Admit input through admission service
        admitted = await input_service.admit_input(
            message="Original query",
            session_id="sess-scan",
            user=user,
            gateway=mock_gw,
        )
        assert mock_gw.validate_input.call_count == 1
        assert admitted.validated_input is not None

        # 2. ChatController forwards validated input directly to runner
        mock_runner = MagicMock()
        captured_kwargs: dict = {}

        async def mock_run_gen(command, validated_input=None):
            captured_kwargs["validated_input"] = validated_input
            yield TokenEvent(data=TokenPayload(content="Result"))
            yield DoneEvent(data=DonePayload(sessionId=command.session_id))

        mock_runner.run = mock_run_gen

        controller = ChatController(runner=mock_runner, gateway=mock_gw)
        command = ChatTurnCommand(
            user_id=user.user_id,
            session_id="sess-scan",
            message="Original query",
            token=user.token,
            trace_id=user.trace_id,
            correlation_id=user.correlation_id,
        )

        events = [
            ev async for ev in controller.stream(command, admission_decision=admitted.decision)
        ]
        assert len(events) == 2
        # Zero additional scans by gateway
        assert mock_gw.validate_input.call_count == 1
        # Runner received the exact validated input produced by admission
        assert captured_kwargs["validated_input"] is admitted.validated_input

    @pytest.mark.asyncio
    async def test_modular_input_admission_empty_or_none_message(self):
        """Empty or None message returns PASS decision with None validated_input without calling gateway.validate_input."""
        input_service = InputAdmissionService()
        mock_gw = MagicMock(spec=GuardrailGateway)
        mock_gw.is_healthy.return_value = True
        mock_gw.validate_input = AsyncMock()

        user = AuthenticatedUser(
            user_id="user-empty",
            token="token-empty",
            trace_id="tr-empty",
            correlation_id="cor-empty",
        )

        for empty_msg in [None, ""]:
            result = await input_service.admit_input(
                message=empty_msg,
                session_id="sess-empty",
                user=user,
                gateway=mock_gw,
            )
            assert result.decision.status == "PASS"
            assert result.validated_input is not None
            assert result.validated_input.content == ""
            assert result.blocked_event is None
            assert result.is_blocked is False
            assert mock_gw.validate_input.call_count == 0

    @pytest.mark.asyncio
    async def test_modular_input_admission_blocked_event_details(self):
        """InputAdmissionService returns canonical ErrorEvent and is_blocked=True when blocked."""
        input_service = InputAdmissionService()
        mock_gw = MagicMock(spec=GuardrailGateway)
        mock_gw.is_healthy.return_value = True

        user = AuthenticatedUser(
            user_id="user-block",
            token="token-block",
            trace_id="tr-block",
            correlation_id="cor-block",
        )

        # 1. PII block
        mock_gw.validate_input = AsyncMock(
            return_value=PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_PII,
                reason="PII detected",
            )
        )
        pii_res = await input_service.admit_input(
            message="My SSN is 000-00-0000",
            session_id="sess-block-1",
            user=user,
            gateway=mock_gw,
        )
        assert pii_res.is_blocked is True
        assert pii_res.validated_input is None
        assert pii_res.blocked_event is not None
        assert pii_res.blocked_event.event == "error"
        assert pii_res.blocked_event.data.code == "GUARDRAIL_BLOCKED"
        assert (
            pii_res.blocked_event.data.message
            == "Your message contains protected personal information and cannot be processed."
        )

        # 2. Generic block (e.g. injection)
        mock_gw.validate_input = AsyncMock(
            return_value=PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Injection payload detected",
            )
        )
        inj_res = await input_service.admit_input(
            message="Ignore instructions",
            session_id="sess-block-2",
            user=user,
            gateway=mock_gw,
        )
        assert inj_res.is_blocked is True
        assert inj_res.validated_input is None
        assert inj_res.blocked_event is not None
        assert inj_res.blocked_event.event == "error"
        assert inj_res.blocked_event.data.code == GUARDRAIL_INPUT_INJECTION
        assert (
            inj_res.blocked_event.data.message
            == f"Input rejected by security guardrail: {GUARDRAIL_INPUT_INJECTION}"
        )

    @pytest.mark.asyncio
    async def test_create_blocked_sse_response_helper(self):
        """create_blocked_sse_response yields canonical SSE formatted event."""
        from agent.chat_turn.events import ErrorEvent, ErrorPayload

        blocked_event = ErrorEvent(
            data=ErrorPayload(
                code="GUARDRAIL_BLOCKED",
                message="Your message contains protected personal information and cannot be processed.",
                partialMessageId=None,
            )
        )
        response = create_blocked_sse_response(blocked_event)
        assert response.status_code == 200
        assert "text/event-stream" in response.headers.get("content-type", "")

        body_parts: list[dict[str, str]] = []
        async for chunk in response.body_iterator:
            if isinstance(chunk, dict):
                body_parts.append(chunk)
            elif isinstance(chunk, (str, bytes)):
                text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
                for line in text.splitlines():
                    if line.startswith("data:"):
                        body_parts.append({"data": line.split(":", 1)[1].strip()})
        assert len(body_parts) > 0

    @pytest.mark.asyncio
    async def test_quota_service_success_telemetry(self):
        """QuotaService admits request and emits accepted telemetry with redis dependency."""
        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(return_value=True)
        mock_redis = MagicMock()
        mock_telemetry = MagicMock()

        quota_service = QuotaService(
            redis_client_factory=lambda: mock_redis,
            budget_repo_factory=MagicMock(return_value=mock_budget),
            telemetry=mock_telemetry,
        )

        trace_id = "chat_" + "1" * 32
        correlation_id = "chat_" + "2" * 32
        await quota_service.check_quota(
            user_id="user-qs-1",
            trace_id=trace_id,
            correlation_id=correlation_id,
        )

        assert mock_budget.admit_request.call_count == 1
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[0][0] == "quota_admission"
        assert call_args[1]["status"] == "accepted"
        assert call_args[1]["trace_id"] == trace_id
        assert call_args[1]["correlation_id"] == correlation_id
        assert call_args[1]["fields"] == {"outcome": "admitted", "dependency": "redis"}
        assert call_args[1]["latency_ms"] >= 0

    @pytest.mark.asyncio
    async def test_quota_service_daily_quota_exceeded(self):
        """BudgetExceededException containing daily raises 429 and emits rejected daily_quota."""
        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(
            side_effect=BudgetExceededException("daily_quota_exceeded")
        )
        mock_redis = MagicMock()
        mock_telemetry = MagicMock()

        quota_service = QuotaService(
            redis_client_factory=lambda: mock_redis,
            budget_repo_factory=MagicMock(return_value=mock_budget),
            telemetry=mock_telemetry,
        )

        trace_id = "chat_" + "3" * 32
        correlation_id = "chat_" + "4" * 32
        with pytest.raises(HTTPException) as exc_info:
            await quota_service.check_quota(
                user_id="user-qs-2",
                trace_id=trace_id,
                correlation_id=correlation_id,
            )

        assert exc_info.value.status_code == 429
        assert exc_info.value.detail == "CHAT_DAILY_QUOTA_EXCEEDED"
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[0][0] == "quota_admission"
        assert call_args[1]["status"] == "rejected"
        assert call_args[1]["trace_id"] == trace_id
        assert call_args[1]["correlation_id"] == correlation_id
        assert call_args[1]["fields"] == {"outcome": "rejected", "error_class": "daily_quota"}

    @pytest.mark.asyncio
    async def test_quota_service_burst_limit_exceeded(self):
        """BudgetExceededException containing burst raises 429 and emits rejected burst_limit."""
        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(
            side_effect=BudgetExceededException("burst_limit_exceeded")
        )
        mock_redis = MagicMock()
        mock_telemetry = MagicMock()

        quota_service = QuotaService(
            redis_client_factory=lambda: mock_redis,
            budget_repo_factory=MagicMock(return_value=mock_budget),
            telemetry=mock_telemetry,
        )

        trace_id = "chat_" + "5" * 32
        correlation_id = "chat_" + "6" * 32
        with pytest.raises(HTTPException) as exc_info:
            await quota_service.check_quota(
                user_id="user-qs-3",
                trace_id=trace_id,
                correlation_id=correlation_id,
            )

        assert exc_info.value.status_code == 429
        assert exc_info.value.detail == "CHAT_BURST_LIMIT_EXCEEDED"
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[0][0] == "quota_admission"
        assert call_args[1]["status"] == "rejected"
        assert call_args[1]["trace_id"] == trace_id
        assert call_args[1]["correlation_id"] == correlation_id
        assert call_args[1]["fields"] == {"outcome": "rejected", "error_class": "burst_limit"}

    @pytest.mark.asyncio
    async def test_quota_service_redis_client_none_or_raises_503(self):
        """Missing or uninitialized redis client raises 503 and emits degraded telemetry."""
        mock_telemetry = MagicMock()

        # Case A: returns None
        qs_none = QuotaService(
            redis_client_factory=lambda: None,
            telemetry=mock_telemetry,
        )
        with pytest.raises(HTTPException) as exc_none:
            await qs_none.check_quota(
                user_id="user-qs-4",
                trace_id="chat_" + "7" * 32,
                correlation_id="chat_" + "8" * 32,
            )
        assert exc_none.value.status_code == 503
        assert exc_none.value.detail == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[1]["status"] == "degraded"
        assert call_args[1]["fields"] == {
            "outcome": "unavailable",
            "error_class": "control_plane_unavailable",
        }

        # Case B: factory raises exception
        def raise_factory():
            raise RuntimeError("Redis connection failed")

        mock_telemetry.reset_mock()
        qs_raise = QuotaService(
            redis_client_factory=raise_factory,
            telemetry=mock_telemetry,
        )
        with pytest.raises(HTTPException) as exc_raise:
            await qs_raise.check_quota(
                user_id="user-qs-4",
                trace_id="chat_" + "7" * 32,
                correlation_id="chat_" + "8" * 32,
            )
        assert exc_raise.value.status_code == 503
        assert exc_raise.value.detail == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[1]["status"] == "degraded"
        assert call_args[1]["fields"] == {
            "outcome": "unavailable",
            "error_class": "control_plane_unavailable",
        }

    @pytest.mark.asyncio
    async def test_quota_service_redis_unavailable_exception_503(self):
        """RedisUnavailableException from admit_request raises 503 and emits degraded telemetry."""
        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(
            side_effect=RedisUnavailableException("connection reset")
        )
        mock_redis = MagicMock()
        mock_telemetry = MagicMock()

        quota_service = QuotaService(
            redis_client_factory=lambda: mock_redis,
            budget_repo_factory=MagicMock(return_value=mock_budget),
            telemetry=mock_telemetry,
        )

        with pytest.raises(HTTPException) as exc_info:
            await quota_service.check_quota(
                user_id="user-qs-5",
                trace_id="chat_" + "9" * 32,
                correlation_id="chat_" + "0" * 32,
            )

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[1]["status"] == "degraded"
        assert call_args[1]["fields"] == {
            "outcome": "unavailable",
            "error_class": "control_plane_unavailable",
        }

    @pytest.mark.asyncio
    async def test_quota_service_unexpected_exception_503(self):
        """Unexpected exception from admit_request raises 503 and emits degraded telemetry."""
        mock_budget = MagicMock()
        mock_budget.admit_request = AsyncMock(side_effect=RuntimeError("unknown error"))
        mock_redis = MagicMock()
        mock_telemetry = MagicMock()

        quota_service = QuotaService(
            redis_client_factory=lambda: mock_redis,
            budget_repo_factory=MagicMock(return_value=mock_budget),
            telemetry=mock_telemetry,
        )

        with pytest.raises(HTTPException) as exc_info:
            await quota_service.check_quota(
                user_id="user-qs-6",
                trace_id="chat_" + "a" * 32,
                correlation_id="chat_" + "b" * 32,
            )

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        assert mock_telemetry.emit_safely.call_count == 1
        call_args = mock_telemetry.emit_safely.call_args
        assert call_args[1]["status"] == "degraded"
        assert call_args[1]["fields"] == {
            "outcome": "unavailable",
            "error_class": "control_plane_unavailable",
        }

    @pytest.mark.asyncio
    async def test_quota_service_repo_resolution_and_patching(self):
        """Verify repository resolution order and compatibility with patching."""
        mock_redis = MagicMock()

        # 1. Constructor injected budget_repo_factory takes priority
        custom_factory = MagicMock()
        custom_repo = MagicMock()
        custom_repo.admit_request = AsyncMock(return_value=True)
        custom_factory.return_value = custom_repo

        qs1 = QuotaService(
            redis_client_factory=lambda: mock_redis,
            budget_repo_factory=custom_factory,
        )
        await qs1.check_quota(user_id="u1", trace_id="tr1", correlation_id="cor1")
        custom_factory.assert_called_once_with(mock_redis)

        # 2. Patching agent.repositories.chat_budget_repository.ChatBudgetRepository
        patched_repo = MagicMock()
        patched_repo.admit_request = AsyncMock(return_value=True)
        patched_cls = MagicMock(return_value=patched_repo)

        with patch("agent.repositories.chat_budget_repository.ChatBudgetRepository", patched_cls):
            qs2 = QuotaService(redis_client_factory=lambda: mock_redis)
            await qs2.check_quota(user_id="u2", trace_id="tr2", correlation_id="cor2")
            patched_cls.assert_called_once_with(mock_redis)

        # 3. Patching agent.admission.quota.ChatBudgetRepository
        patched_repo3 = MagicMock()
        patched_repo3.admit_request = AsyncMock(return_value=True)
        patched_cls3 = MagicMock(return_value=patched_repo3)

        with patch("agent.admission.quota.ChatBudgetRepository", patched_cls3):
            qs3 = QuotaService(redis_client_factory=lambda: mock_redis)
            await qs3.check_quota(user_id="u3", trace_id="tr3", correlation_id="cor3")
            patched_cls3.assert_called_once_with(mock_redis)

        # 4. Default wiring uses get_redis_client and ChatBudgetRepository
        qs_default = QuotaService(budget_repo_factory=ChatBudgetRepository)
        assert qs_default.redis_client_factory is get_redis_client
        assert qs_default.budget_repo_factory is ChatBudgetRepository
