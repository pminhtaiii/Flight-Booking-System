import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import ValidationError

from agent.chat_turn import (
    ActionHandoffEvent,
    ActionRequiredEvent,
    ChatTurnCommand,
    ChatTurnRunner,
    DoneEvent,
    ErrorEvent,
    FlightResultsEvent,
    TokenEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from agent.guardrails.base import ValidatedInput
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.output_pipeline import OutputGuardrailBlockedError
from agent.guardrails.registry import create_production_registry


def test_chat_turn_command_valid_and_extra_forbid():
    cmd = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Search flights to NYC",
        action_required=True,
        action_type="begin_checkout",
        action_payload={"offer_id": "off_1"},
        token="jwt.token.val",
        trace_id="chat_0123456789abcdef0123456789abcdef",
        correlation_id="chat_fedcba9876543210fedcba9876543210",
    )
    assert cmd.user_id == "user-123"
    assert cmd.session_id == "session-456"
    assert cmd.message == "Search flights to NYC"
    assert cmd.action_required is True
    assert cmd.action_type == "begin_checkout"
    assert cmd.action_payload == {"offer_id": "off_1"}
    assert cmd.token == "jwt.token.val"
    assert cmd.trace_id == "chat_0123456789abcdef0123456789abcdef"
    assert cmd.correlation_id == "chat_fedcba9876543210fedcba9876543210"

    # Defaults
    cmd_min = ChatTurnCommand(user_id="u1", token="tok1")
    assert cmd_min.session_id is None
    assert cmd_min.message is None
    assert cmd_min.action_required is False
    assert cmd_min.action_type is None
    assert cmd_min.action_payload is None
    assert cmd_min.trace_id is None
    assert cmd_min.correlation_id is None

    # Extra fields forbidden
    with pytest.raises(ValidationError):
        ChatTurnCommand(user_id="u1", token="t1", extra_invalid_key="fail")


@pytest.mark.asyncio
async def test_runner_happy_path_streaming():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hello! How can I help?")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = []
    async for event in runner.run(command):
        events.append(event)

    # Monotonic fencing token set
    mock_client.set_fencing_token.assert_called_with(42)

    # Queue lease acquired and released
    mock_queue.acquire.assert_awaited_once_with("session-456", user_id="user-123")
    mock_queue.release.assert_awaited_once_with("session-456", "req-123")

    # Tokens and DoneEvent
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    assert len(token_events) > 0
    assert any("Hello" in e.data.content for e in token_events)

    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.messageId == "msg_agent_1"
    assert done_events[0].data.sessionId == "session-456"


@pytest.mark.asyncio
async def test_production_runner_passes_mandatory_gateway_into_graph_config() -> None:
    """The live graph must receive the same production gateway used at admission."""
    captured: dict[str, object] = {}
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg-agent", "sender": "AGENT"}]}
    )
    mock_graph = MagicMock()

    async def capture_astream_events(initial_state, *, config, version):
        captured.update(initial_state=initial_state, config=config, version=version)
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Safe response")},
        }

    mock_graph.astream_events = capture_astream_events
    gateway = GuardrailGateway(create_production_registry())
    runner = ChatTurnRunner(
        graph=mock_graph,
        client_factory=lambda **_kwargs: mock_client,
        redis_client=None,
        gateway=gateway,
        require_gateway=True,
    )

    events = [
        event
        async for event in runner.run(
            ChatTurnCommand(
                user_id="user-production-gateway",
                session_id="session-production-gateway",
                message="Hello",
                token="token",
            ),
            validated_input=ValidatedInput(content="Hello"),
        )
    ]

    assert any(isinstance(event, DoneEvent) for event in events)
    configurable = captured["config"]["configurable"]
    assert configurable["guardrail_gateway"] is gateway
    assert configurable["guardrail_gateway"].registry is gateway.registry
    assert "turn_capabilities" not in configurable
    assert "turn_capabilities" not in captured["initial_state"]


@pytest.mark.asyncio
async def test_runner_session_auto_creation_when_none():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "auto-created-session-999"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_1", "sender": "AGENT"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Hi")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id=None,
        message="Hi",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]
    mock_client.create_session.assert_awaited_once_with(title=None)

    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1
    assert done_events[0].data.sessionId == "auto-created-session-999"


@pytest.mark.asyncio
async def test_runner_tool_calls_and_flight_results():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "search_flights",
                                    "args": {
                                        "origin": "SFO",
                                        "destination": "JFK",
                                        "date": "2026-09-01",
                                    },
                                    "id": "call-search-1",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": json.dumps({"status": "found", "count": 2})},
        }
        # Raw callbacks are telemetry-only; public results come from the
        # gateway-validated ToolMessage emitted by the tools node.
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"status": "found", "count": 2}),
                            tool_call_id="call-search-1",
                            name="search_flights",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Found 2 flights.")},
        }

    mock_graph.astream_events = mock_astream_events

    mock_projected_item = MagicMock()
    mock_projected_item.model_dump = MagicMock(
        return_value={
            "index": 1,
            "airline": "United Airlines",
            "origin": "SFO",
            "destination": "JFK",
            "departureAt": "2026-09-01T08:00:00Z",
            "arrivalAt": "2026-09-01T16:00:00Z",
            "price": "350.00",
            "currency": "USD",
        }
    )
    mock_snapshot = MagicMock()
    mock_lifecycle = MagicMock()
    mock_lifecycle.load_active = AsyncMock(return_value=mock_snapshot)
    mock_lifecycle.project_for_browser = MagicMock(return_value=[mock_projected_item])

    with patch(
        "agent.chat_turn.runner.TrustedSearchSnapshotLifecycle",
        return_value=mock_lifecycle,
    ):
        runner = ChatTurnRunner(
            graph=mock_graph,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-456",
            message="Flights to NYC",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

        tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
        assert len(tool_calls) == 1
        assert tool_calls[0].data.name == "search_flights"
        assert tool_calls[0].data.inputs == {
            "origin": "SFO",
            "destination": "JFK",
            "date": "2026-09-01",
        }

        tool_results = [e for e in events if isinstance(e, ToolResultEvent)]
        assert len(tool_results) == 1
        assert tool_results[0].data.name == "search_flights"

        flight_results = [e for e in events if isinstance(e, FlightResultsEvent)]
        assert len(flight_results) == 1
        assert len(flight_results[0].data.results) == 1
        result_data = flight_results[0].data.results[0]
        assert result_data["index"] == 1
        assert result_data["airline"] == "United Airlines"
        assert result_data["price"] == "350.00"
        for forbidden in [
            "score",
            "matchScore",
            "matchLevel",
            "matchResult",
            "flightOfferId",
            "duffelOfferId",
        ]:
            assert forbidden not in result_data


@pytest.mark.asyncio
async def test_runner_check_booking_readiness_sanitized_and_action_required():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-1")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    raw_readiness = {
        "scope": "INTERNATIONAL",
        "ready": False,
        "nextAction": "COMPLETE_PASSENGERS",
        "passengers": [],
        "canary": "raw-callback-must-not-drive-action",
    }
    validated_readiness = {
        "scope": "DOMESTIC",
        "ready": False,
        "nextAction": "COMPLETE_PROFILE",
        "passengers": [
            {
                "passengerType": "ADULT",
                "passengerOrdinal": 1,
                "sections": [
                    {
                        "name": "identity",
                        "fields": [
                            {"name": "givenName", "status": "missing", "reason": "REQUIRED"}
                        ],
                    }
                ],
            }
        ],
    }

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "name": "check_booking_readiness",
                                    "args": {
                                        "flight_offer_id": "secret_offer_123",
                                        "passengers": [
                                            {
                                                "passengerType": "ADULT",
                                                "passengerOrdinal": 1,
                                                "sourceType": "traveler_profile",
                                            }
                                        ],
                                    },
                                    "id": "call-readiness-1",
                                }
                            ],
                        )
                    ]
                }
            },
        }
        # Raw tool input with sensitive information must NOT leak
        yield {
            "event": "on_tool_start",
            "name": "check_booking_readiness",
            "data": {
                "input": {"flight_offer_id": "secret_offer_123", "passengers": [{"name": "PII"}]}
            },
        }
        yield {
            "event": "on_tool_end",
            "name": "check_booking_readiness",
            "data": {"output": raw_readiness},
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps(validated_readiness),
                            tool_call_id="call-readiness-1",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Book this flight",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    # Tool call event sanitized
    tool_calls = [e for e in events if isinstance(e, ToolCallEvent)]
    assert len(tool_calls) == 1
    assert tool_calls[0].data.name == "check_booking_readiness"
    assert tool_calls[0].data.inputs == {"message": "Checking booking readiness..."}
    assert "secret_offer_123" not in str(tool_calls[0].data.inputs)

    # ActionRequiredEvent yielded
    act_required = [e for e in events if isinstance(e, ActionRequiredEvent)]
    assert len(act_required) == 1
    assert act_required[0].data.action == "COMPLETE_PROFILE"
    assert act_required[0].data.target == "/profile"
    assert act_required[0].data.scope == "DOMESTIC"
    assert act_required[0].data.passengers is not None
    assert act_required[0].data.passengers[0]["passengerType"] == "ADULT"
    assert "raw-callback-must-not-drive-action" not in repr(events)

    # Queue lease released upon action required
    mock_queue.release.assert_awaited_once_with("session-456", "req-1")


@pytest.mark.asyncio
async def test_runner_tool_block_emits_static_guardrail_error_without_raw_callbacks():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-block")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"secret": "raw callback must not publish"}},
        }
        yield {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "tool_blocked": True,
                    "tool_block_response_key": "GUARDRAIL_TOOL_PII",
                }
            },
        }

    mock_graph.astream_events = mock_astream_events
    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    events = [
        event
        async for event in runner.run(
            ChatTurnCommand(
                user_id="user-123",
                session_id="session-block",
                message="Search safely",
                token="mock_token",
            )
        )
    ]

    assert not [event for event in events if isinstance(event, ToolCallEvent)]
    errors = [event for event in events if isinstance(event, ErrorEvent)]
    assert len(errors) == 1
    assert errors[0].data.code == "GUARDRAIL_TOOL_PII"
    assert errors[0].data.message == "Tool execution was blocked for safety reasons."
    assert "raw callback must not publish" not in repr(events)


@pytest.mark.asyncio
async def test_runner_action_handoff_event():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_agent_2", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-2")
    mock_queue.get_fence = MagicMock(return_value=2)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chain_end",
            "name": "create_handoff_token",
            "data": {
                "output": {
                    "action": {
                        "action": "begin_checkout",
                        "handoffToken": "chk_tok_abc",
                        "expiresAt": "2026-08-30T12:00:00Z",
                        "display": {"airline": "Delta", "price": "400"},
                    }
                }
            },
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Confirm booking",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    handoff_events = [e for e in events if isinstance(e, ActionHandoffEvent)]
    assert len(handoff_events) == 1
    assert handoff_events[0].data.handoffToken == "chk_tok_abc"
    assert handoff_events[0].data.action == "begin_checkout"
    assert handoff_events[0].data.display == {"airline": "Delta", "price": "400"}

    # DoneEvent emitted because force_persistence was set
    done_events = [e for e in events if isinstance(e, DoneEvent)]
    assert len(done_events) == 1


@pytest.mark.asyncio
async def test_runner_causal_failure_cleanup_on_guardrail_block():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_msg_id", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-gr")
    mock_queue.get_fence = MagicMock(return_value=3)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    call_order = []

    mock_pipeline = MagicMock()

    async def mock_process_token(token):
        call_order.append("process_token")
        yield "Safe part "
        raise OutputGuardrailBlockedError(
            partial_response="Safe part ",
            layer="nemo",
            rule="unsafe",
            message="Violated guardrail policy",
        )

    mock_pipeline.process_token = mock_process_token

    async def mock_aclose():
        call_order.append("aclose")

    mock_pipeline.aclose = mock_aclose

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Safe part Unsafe content")},
        }

    mock_graph.astream_events = mock_astream_events

    with patch("agent.chat_turn.runner.OutputGuardrailPipeline", return_value=mock_pipeline):
        # Instrument persist_response and queue_release to track order
        orig_persist = mock_client.create_message_batch

        async def tracked_persist(s_id, messages, *args, **kwargs):
            if any(m.get("sender") == "USER" for m in messages):
                call_order.append("user_pre_persist")
            else:
                call_order.append("partial_persist")
            return await orig_persist(s_id, messages, *args, **kwargs)

        mock_client.create_message_batch = tracked_persist

        orig_release = mock_queue.release

        async def tracked_release(*args, **kwargs):
            call_order.append("release")
            return await orig_release(*args, **kwargs)

        mock_queue.release = tracked_release

        runner = ChatTurnRunner(
            graph=mock_graph,
            queue_manager=mock_queue,
            client_factory=lambda **kwargs: mock_client,
            redis_client=MagicMock(),
        )

        command = ChatTurnCommand(
            user_id="user-123",
            session_id="session-456",
            message="Tell me something",
            token="mock_token",
        )

        events = [e async for e in runner.run(command)]

        # Verify causal ordering: partial_persist -> aclose -> release
        assert call_order == [
            "user_pre_persist",
            "process_token",
            "partial_persist",
            "aclose",
            "release",
        ]

        error_events = [e for e in events if isinstance(e, ErrorEvent)]
        assert len(error_events) == 1
        assert error_events[0].data.code == "OUTPUT_GUARDRAIL_BLOCKED"
        assert error_events[0].data.partialMessageId == "partial_msg_id"


@pytest.mark.asyncio
async def test_runner_causal_failure_cleanup_on_llm_error():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_msg_2", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-llm")
    mock_queue.get_fence = MagicMock(return_value=4)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Partial content before crash ")},
        }
        raise RuntimeError("LLM service unavailable")

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Tell me something",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "LLM_ERROR"
    assert error_events[0].data.partialMessageId == "partial_msg_2"
    mock_queue.release.assert_awaited_once_with("session-456", "req-llm")


@pytest.mark.asyncio
async def test_runner_stale_fence_aborts_persistence():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(return_value={"messages": []})

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-stale")
    mock_queue.get_fence = MagicMock(return_value=5)
    # Lost lock during generation
    mock_queue.validate_active_fence = AsyncMock(return_value=False)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Completed message")},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = [e async for e in runner.run(command)]

    error_events = [e for e in events if isinstance(e, ErrorEvent)]
    assert len(error_events) == 1
    assert error_events[0].data.code == "PERSISTENCE_ERROR"


@pytest.mark.asyncio
async def test_runner_cancellation_shielded_persistence():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_cancel_id", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-cancel")
    mock_queue.get_fence = MagicMock(return_value=6)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Some partial response")},
        }
        raise asyncio.CancelledError()

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Cancel me",
        token="mock_token",
    )

    with pytest.raises(asyncio.CancelledError):
        async for _ in runner.run(command):
            pass

    # Partial turn was persisted and lock was released
    assert mock_client.create_message_batch.await_count >= 1
    mock_queue.release.assert_awaited_once_with("session-456", "req-cancel")


@pytest.mark.asyncio
async def test_runner_generator_exit_shielded_persistence():
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "partial_gen_exit_id", "sender": "AGENT"}]}
    )

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-gen-exit")
    mock_queue.get_fence = MagicMock(return_value=7)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Partial response before close")},
        }
        # Simulate further processing or sleep if not closed
        await asyncio.sleep(10)

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Close early",
        token="mock_token",
    )

    gen = runner.run(command)
    # Receive first token
    event = await anext(gen)
    assert isinstance(event, TokenEvent)

    # Early exit generator (sends GeneratorExit)
    await gen.aclose()

    # Partial turn was persisted and lock was released
    assert mock_client.create_message_batch.await_count >= 1
    mock_queue.release.assert_awaited_once_with("session-456", "req-gen-exit")


@pytest.mark.asyncio
async def test_runner_cancellation_bounded_timeout_on_stuck_dependency():
    """Ensure runner cancellation does not hang if persistence or queue release is stuck."""
    pytest.skip("Legacy shielded-persistence drill superseded by deterministic Phase 3 cleanup")
    mock_client = MagicMock()
    mock_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})

    # create_message_batch hangs indefinitely
    async def mock_hanging_persist(*args, **kwargs):
        await asyncio.sleep(100)
        return {}

    mock_client.create_message_batch = mock_hanging_persist

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-hang")
    mock_queue.get_fence = MagicMock(return_value=1)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)

    # release hangs indefinitely
    async def mock_hanging_release(*args, **kwargs):
        await asyncio.sleep(100)

    mock_queue.release = mock_hanging_release

    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        yield {
            "event": "on_chat_model_stream",
            "data": {"chunk": MagicMock(content="Token before cancel")},
        }
        raise asyncio.CancelledError()

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Cancel with stuck deps",
        token="mock_token",
    )

    # Must complete cancellation within ~6s (well before 100s) despite stuck dependencies
    with pytest.raises(asyncio.CancelledError):
        async for _ in runner.run(command):
            pass


@pytest.mark.asyncio
async def test_on_chat_model_end_prevents_duplicate_on_chain_end():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_usr_1"}, {"id": "msg_agent_1"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    msg = MagicMock(content="Hello traveler!")
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Model completes without streaming chunks
        yield {
            "event": "on_chat_model_end",
            "data": {"output": msg},
        }
        # Followed by on_chain_end containing the same message
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Hello",
        token="mock_token",
    )

    events = [event async for event in runner.run(command)]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    emitted_text = "".join(e.data.content for e in token_events)

    # Content should be emitted exactly once, not duplicated
    assert emitted_text == "Hello traveler!"


@pytest.mark.asyncio
async def test_multiple_model_invocations_emit_later_model_output_without_duplication():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_usr_1"}, {"id": "msg_agent_1"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    msg1 = MagicMock(content="Thinking: checking flights...")
    msg2 = MagicMock(content="Here are your flights: Flight 101...")
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Event 1: on_chat_model_end with msg1
        yield {
            "event": "on_chat_model_end",
            "data": {"output": msg1},
        }
        # Event 2: on_chain_end for travel node with messages: [msg1]
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg1]}},
        }
        # Event 3: on_tool_start / on_tool_end
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"destination": "NYC"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"flights": ["Flight 101"]}'},
        }
        # Event 4: on_chat_model_end with msg2
        yield {
            "event": "on_chat_model_end",
            "data": {"output": msg2},
        }
        # Event 5: on_chain_end for final_answer node with messages: [msg2]
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [msg2]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Find flights",
        token="mock_token",
    )

    events = [event async for event in runner.run(command)]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    emitted_text = "".join(e.data.content for e in token_events)

    # Both msg1 and msg2 must be emitted without duplication
    assert "Thinking: checking flights..." in emitted_text
    assert "Here are your flights: Flight 101..." in emitted_text
    assert emitted_text == "Thinking: checking flights...Here are your flights: Flight 101..."


@pytest.mark.asyncio
async def test_streaming_first_model_and_non_streaming_second_model_with_run_ids():
    mock_client = MagicMock()
    mock_client.create_session = AsyncMock(return_value={"id": "session-123"})
    mock_client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    mock_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "msg_usr_1"}, {"id": "msg_agent_1"}]}
    )
    mock_client.set_fencing_token = MagicMock()

    mock_queue = MagicMock()
    mock_queue.acquire = AsyncMock(return_value="req-123")
    mock_queue.get_fence = MagicMock(return_value=42)
    mock_queue.validate_active_fence = AsyncMock(return_value=True)
    mock_queue.release = AsyncMock()

    msg1 = MagicMock(content="Thinking: checking flights...")
    msg2 = MagicMock(content="Here are your flights: Flight 101...")
    mock_graph = MagicMock()

    async def mock_astream_events(*args, **kwargs):
        # Event 1: Model 1 streams chunks
        yield {
            "event": "on_chat_model_stream",
            "run_id": "run-model-1",
            "data": {"chunk": MagicMock(content="Thinking: checking flights...")},
        }
        # Event 2: Model 1 ends
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-model-1",
            "data": {"output": msg1},
        }
        # Event 3: travel node ends
        yield {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [msg1]}},
        }
        # Event 4: tool executes
        yield {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"destination": "NYC"}},
        }
        yield {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"flights": ["Flight 101"]}'},
        }
        # Event 5: Model 2 completes non-streaming
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-model-2",
            "data": {"output": msg2},
        }
        # Event 6: final_answer node ends
        yield {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [msg1, msg2]}},
        }

    mock_graph.astream_events = mock_astream_events

    runner = ChatTurnRunner(
        graph=mock_graph,
        queue_manager=mock_queue,
        client_factory=lambda **kwargs: mock_client,
        redis_client=MagicMock(),
    )

    command = ChatTurnCommand(
        user_id="user-123",
        session_id="session-456",
        message="Find flights",
        token="mock_token",
    )

    events = [event async for event in runner.run(command)]
    token_events = [e for e in events if isinstance(e, TokenEvent)]
    emitted_text = "".join(e.data.content for e in token_events)

    assert "Thinking: checking flights..." in emitted_text
    assert "Here are your flights: Flight 101..." in emitted_text
    assert emitted_text == "Thinking: checking flights...Here are your flights: Flight 101..."
