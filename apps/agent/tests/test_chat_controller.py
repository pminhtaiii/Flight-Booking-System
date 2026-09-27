from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.controller import ChatController
from agent.chat_turn.events import DoneEvent, DonePayload, TokenEvent, TokenPayload
from agent.guardrails.base import AdmissionContext, PipelineDecision, ValidatedInput
from agent.guardrails.gateway import GuardrailGateway


@pytest.mark.asyncio
async def test_chat_controller_requires_gateway():
    """ChatController emits GUARDRAIL_CONFIGURATION_ERROR if gateway is absent."""
    mock_runner = MagicMock()
    controller = ChatController(runner=mock_runner, gateway=None)
    command = ChatTurnCommand(
        user_id="user-123",
        session_id="sess-test",
        message="Hello",
        token="test-token",
    )

    events = [ev async for ev in controller.stream(command)]
    assert len(events) == 1
    assert events[0].event == "error"
    assert events[0].data.code == "GUARDRAIL_CONFIGURATION_ERROR"


@pytest.mark.asyncio
async def test_chat_controller_prevents_redundant_validation():
    """ChatController does not call validate_input when admission_decision is provided."""
    mock_runner = MagicMock()

    async def mock_run_gen(command, validated_input=None):
        yield TokenEvent(data=TokenPayload(content="Hello"))
        yield DoneEvent(data=DonePayload(sessionId=command.session_id))

    mock_runner.run = mock_run_gen

    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.validate_input = AsyncMock()

    controller = ChatController(runner=mock_runner, gateway=mock_gateway)
    command = ChatTurnCommand(
        user_id="user-123",
        session_id="sess-test",
        message="Search flights",
        token="test-token",
    )
    admission_decision = PipelineDecision(
        status="PASS",
        validated_data=ValidatedInput(content="Search flights"),
    )

    events = [ev async for ev in controller.stream(command, admission_decision=admission_decision)]
    assert len(events) == 2
    assert mock_gateway.validate_input.call_count == 0


@pytest.mark.asyncio
async def test_chat_controller_validates_when_admission_decision_absent():
    """ChatController calls gateway.validate_input when admission_decision is None."""
    mock_runner = MagicMock()

    async def mock_run_gen(command, validated_input=None):
        yield TokenEvent(data=TokenPayload(content="Hello"))
        yield DoneEvent(data=DonePayload(sessionId=command.session_id))

    mock_runner.run = mock_run_gen

    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.validate_input = AsyncMock(
        return_value=PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content="Search flights"),
        )
    )

    controller = ChatController(runner=mock_runner, gateway=mock_gateway)
    command = ChatTurnCommand(
        user_id="user-123",
        session_id="sess-test",
        message="Search flights",
        token="test-token",
    )

    events = [ev async for ev in controller.stream(command)]
    assert len(events) == 2
    assert mock_gateway.validate_input.call_count == 1
    assert isinstance(mock_gateway.validate_input.call_args[0][0], AdmissionContext)


@pytest.mark.asyncio
async def test_chat_controller_blocks_invalid_input():
    """ChatController yields ErrorEvent when validation returns BLOCK."""
    mock_runner = MagicMock()
    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.validate_input = AsyncMock(
        return_value=PipelineDecision(
            status="BLOCK",
            response_key="GUARDRAIL_INPUT_INJECTION",
            reason="Blocked by injection layer",
        )
    )

    controller = ChatController(runner=mock_runner, gateway=mock_gateway)
    command = ChatTurnCommand(
        user_id="user-123",
        session_id="sess-test",
        message="Injection payload",
        token="test-token",
    )

    events = [ev async for ev in controller.stream(command)]
    assert len(events) == 1
    assert events[0].event == "error"
    assert events[0].data.code == "GUARDRAIL_INPUT_INJECTION"


@pytest.mark.asyncio
async def test_chat_controller_validation_exception_fails_closed():
    """ChatController fails closed with GUARDRAIL_INPUT_INJECTION on validation exception."""
    mock_runner = MagicMock()
    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.validate_input = AsyncMock(side_effect=RuntimeError("Gateway error"))

    controller = ChatController(runner=mock_runner, gateway=mock_gateway)
    command = ChatTurnCommand(
        user_id="user-123",
        session_id="sess-test",
        message="Payload",
        token="test-token",
    )

    events = [ev async for ev in controller.stream(command)]
    assert len(events) == 1
    assert events[0].event == "error"
    assert events[0].data.code == "GUARDRAIL_INPUT_INJECTION"


@pytest.mark.asyncio
async def test_chat_controller_single_scan_guarantee_forwards_validated_input():
    """
    Single-Scan Guarantee:
    Input validated once during admission; ChatController forwards validated input
    to runner without re-scanning.
    """
    mock_runner = MagicMock()
    captured = {}

    async def mock_run_gen(command, validated_input=None):
        captured["command"] = command
        captured["validated_input"] = validated_input
        yield TokenEvent(data=TokenPayload(content="Hello"))
        yield DoneEvent(data=DonePayload(sessionId=command.session_id))

    mock_runner.run = mock_run_gen

    mock_gateway = MagicMock(spec=GuardrailGateway)
    mock_gateway.validate_input = AsyncMock()

    controller = ChatController(runner=mock_runner, gateway=mock_gateway)
    command = ChatTurnCommand(
        user_id="user-123",
        session_id="sess-test",
        message="Search flights",
        token="test-token",
    )
    validated_payload = ValidatedInput(content="Sanitized flight query")
    admission_decision = PipelineDecision(
        status="PASS",
        validated_data=validated_payload,
    )

    events = [ev async for ev in controller.stream(command, admission_decision=admission_decision)]
    assert len(events) == 2
    # Gateway was not called to re-scan
    assert mock_gateway.validate_input.call_count == 0
    # Runner received the exact validated_input produced by admission
    assert captured.get("validated_input") is validated_payload
