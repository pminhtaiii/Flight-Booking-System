"""Unit tests for GraphEventInterpreter and ProjectionBlockedException (T008).

Verifies graph event translation, tool-name-agnostic forwarding, accepted
ordering, fail-closed projection blocks, handoff resolution, token fallbacks,
and timing-only tool events.
"""

import json
from dataclasses import dataclass
from typing import AsyncIterator, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest
from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionHandoffPayload,
    ActionRequiredEvent,
    ActionRequiredPayload,
    ChatTurnEvent,
    FlightResultsEvent,
    FlightResultsPayload,
    TokenEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from agent.chat_turn.interpreter import (
    GraphEventInterpreter,
    ProjectionBlockedException,
)
from agent.chat_turn.resolver import (
    HandoffResolution,
    ToolResolution,
    ToolResultResolver,
)
from agent.guardrails.base import GUARDRAIL_TOOL_SCHEMA
from langchain_core.messages import AIMessage, ToolMessage


@dataclass
class FakeTurnContext:
    """Mock turn execution context providing session and user identity."""

    user_id: str = "test-user-001"
    session_id: str = "test-session-001"
    chat_session_id: str = "test-session-001"


async def to_stream(*events: dict[str, object]) -> AsyncIterator[dict[str, object]]:
    """Helper to convert dictionary events into an async generator stream."""
    for event in events:
        yield event


async def collect_events(
    interpreter: GraphEventInterpreter,
    stream: AsyncIterator[dict[str, object]],
    context: Optional[FakeTurnContext] = None,
) -> list[ChatTurnEvent]:
    """Helper to drain all events from the interpreter."""
    results: list[ChatTurnEvent] = []
    async for event in interpreter.interpret(stream, context=context):
        results.append(event)
    return results


# ============================================================================
# 1. Tool-Name Agnostic Invariant
# ============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool_name,tool_output",
    [
        ("custom_tool_abc", '{"status": "ok", "custom_field": 42}'),
        ("search_flights", '{"flights": [{"flight_number": "FL101"}]}'),
        ("check_booking_readiness", '{"ready": true}'),
        ("ancillary_seat_picker", '{"selected_seat": "14A"}'),
    ],
)
async def test_tool_name_agnostic_arbitrary_tools_forwarded_identically(
    tool_name: str,
    tool_output: str,
) -> None:
    """Interpreter forwards arbitrary tool names identically to resolver.resolve without inspection."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve = AsyncMock(
        return_value=ToolResolution(
            is_blocked=False,
            summary_override=f"Resolved {tool_name}",
            follow_up_event=None,
        )
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=tool_output,
                            tool_call_id=f"call_{tool_name}",
                            name=tool_name,
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    # Prove resolver.resolve received exact tool name, validated payload, and context
    mock_resolver.resolve.assert_awaited_once_with(tool_name, tool_output, context)

    # Prove interpreter yielded ToolResultEvent with the resolved summary override
    assert len(events) == 1
    assert isinstance(events[0], ToolResultEvent)
    assert events[0].data.name == tool_name
    assert events[0].data.result == f"Resolved {tool_name}"


# ============================================================================
# 2. Accepted Tool Execution Ordering
# ============================================================================


@pytest.mark.asyncio
async def test_accepted_tool_execution_ordering_with_flight_results_follow_up() -> None:
    """on_chain_end (tools) emits ToolCallEvent -> ToolResultEvent -> FlightResultsEvent in strict order."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    follow_up = FlightResultsEvent(
        data=FlightResultsPayload(results=[{"flightNumber": "AA100", "price": 250}])
    )
    mock_resolver.resolve = AsyncMock(
        return_value=ToolResolution(
            is_blocked=False,
            summary_override="Found 1 flight.",
            follow_up_event=follow_up,
        )
    )

    stream = to_stream(
        # 1. Prior node declares pending tool call
        {
            "event": "on_chain_end",
            "name": "travel",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "id": "call_flight_1",
                                    "name": "search_flights",
                                    "args": {"origin": "SFO", "destination": "JFK"},
                                }
                            ],
                        )
                    ]
                }
            },
        },
        # 2. Validated tools node completes
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"flights": ["AA100"]}),
                            tool_call_id="call_flight_1",
                            name="search_flights",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    # Assert exactly 3 events in strict sequence
    assert len(events) == 3
    assert isinstance(events[0], ToolCallEvent)
    assert events[0].data.name == "search_flights"

    assert isinstance(events[1], ToolResultEvent)
    assert events[1].data.name == "search_flights"
    assert events[1].data.result == "Found 1 flight."

    assert isinstance(events[2], FlightResultsEvent)
    assert events[2] is follow_up

    mock_resolver.resolve.assert_awaited_once()


@pytest.mark.asyncio
async def test_accepted_tool_execution_ordering_with_action_required_follow_up() -> None:
    """on_chain_end (tools) emits ToolCallEvent -> ToolResultEvent -> ActionRequiredEvent in strict order."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    follow_up = ActionRequiredEvent(
        data=ActionRequiredPayload(
            action="COMPLETE_PROFILE",
            scope="traveler",
            passengers=[],
            target="/profile",
        )
    )
    mock_resolver.resolve = AsyncMock(
        return_value=ToolResolution(
            is_blocked=False,
            summary_override="Successfully checked booking readiness.",
            follow_up_event=follow_up,
        )
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "checkout",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "id": "call_readiness_1",
                                    "name": "check_booking_readiness",
                                    "args": {},
                                }
                            ],
                        )
                    ]
                }
            },
        },
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content=json.dumps({"ready": False, "nextAction": "COMPLETE_PROFILE"}),
                            tool_call_id="call_readiness_1",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 3
    assert isinstance(events[0], ToolCallEvent)
    assert isinstance(events[1], ToolResultEvent)
    assert isinstance(events[2], ActionRequiredEvent)
    assert events[2] is follow_up


@pytest.mark.asyncio
async def test_accepted_tool_execution_without_follow_up_emits_call_and_result_only() -> None:
    """When resolution has no follow-up, only ToolCallEvent and ToolResultEvent are yielded."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve = AsyncMock(
        return_value=ToolResolution(
            is_blocked=False,
            summary_override="Custom generic output",
            follow_up_event=None,
        )
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "general",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "id": "call_gen_1",
                                    "name": "custom_tool_abc",
                                    "args": {"param": "value"},
                                }
                            ],
                        )
                    ]
                }
            },
        },
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content="Custom generic output",
                            tool_call_id="call_gen_1",
                            name="custom_tool_abc",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 2
    assert isinstance(events[0], ToolCallEvent)
    assert isinstance(events[1], ToolResultEvent)
    assert events[1].data.result == "Custom generic output"


@pytest.mark.asyncio
async def test_accepted_multiple_tool_messages_invokes_resolver_per_message() -> None:
    """Each validated ToolMessage in on_chain_end (tools) invokes resolver.resolve exactly once."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve = AsyncMock(
        side_effect=[
            ToolResolution(
                is_blocked=False,
                summary_override="Summary 1",
                follow_up_event=None,
            ),
            ToolResolution(
                is_blocked=False,
                summary_override="Summary 2",
                follow_up_event=None,
            ),
        ]
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content="res1",
                            tool_call_id="call_1",
                            name="tool_one",
                            additional_kwargs={"guardrail_validated": True},
                        ),
                        ToolMessage(
                            content="res2",
                            tool_call_id="call_2",
                            name="tool_two",
                            additional_kwargs={"guardrail_validated": True},
                        ),
                    ]
                }
            },
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert mock_resolver.resolve.call_count == 2
    assert len(events) == 2
    assert isinstance(events[0], ToolResultEvent)
    assert events[0].data.name == "tool_one"
    assert events[0].data.result == "Summary 1"
    assert isinstance(events[1], ToolResultEvent)
    assert events[1].data.name == "tool_two"
    assert events[1].data.result == "Summary 2"


# ============================================================================
# 3. Invalid Readiness / Blocked Tool Resolution
# ============================================================================


@pytest.mark.asyncio
async def test_blocked_readiness_resolution_raises_projection_blocked_and_yields_no_result() -> (
    None
):
    """When readiness returns is_blocked=True, ProjectionBlockedException is raised with no ToolResultEvent."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve = AsyncMock(
        return_value=ToolResolution(
            is_blocked=True,
            error_code="READINESS_RESPONSE_INVALID",
            error_message="Booking readiness could not be verified safely.",
        )
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "travel",
            "data": {
                "output": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                {
                                    "id": "call_bad_readiness",
                                    "name": "check_booking_readiness",
                                    "args": {},
                                }
                            ],
                        )
                    ]
                }
            },
        },
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content='{"error": "bad backend payload"}',
                            tool_call_id="call_bad_readiness",
                            name="check_booking_readiness",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    yielded_events: list[ChatTurnEvent] = []

    with pytest.raises(ProjectionBlockedException) as exc_info:
        async for event in interpreter.interpret(stream, context=context):
            yielded_events.append(event)

    assert exc_info.value.error_code == "READINESS_RESPONSE_INVALID"
    assert exc_info.value.error_message == "Booking readiness could not be verified safely."

    # Assert that NO ToolResultEvent was yielded before or during the block
    assert all(not isinstance(e, ToolResultEvent) for e in yielded_events)


@pytest.mark.asyncio
async def test_arbitrary_tool_blocked_resolution_raises_projection_blocked() -> None:
    """Arbitrary tool resolution returning is_blocked=True raises ProjectionBlockedException with zero ToolResultEvent."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve = AsyncMock(
        return_value=ToolResolution(
            is_blocked=True,
            error_code="CUSTOM_TOOL_BLOCKED",
            error_message="Custom tool failed domain validation.",
            error_detail="Invalid parameters in domain logic",
        )
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content="raw output",
                            tool_call_id="call_custom",
                            name="custom_tool_abc",
                            additional_kwargs={"guardrail_validated": True},
                        )
                    ]
                }
            },
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    yielded_events: list[ChatTurnEvent] = []

    with pytest.raises(ProjectionBlockedException) as exc_info:
        async for event in interpreter.interpret(stream, context=context):
            yielded_events.append(event)

    assert exc_info.value.error_code == "CUSTOM_TOOL_BLOCKED"
    assert exc_info.value.error_message == "Custom tool failed domain validation."
    assert exc_info.value.error_detail == "Invalid parameters in domain logic"
    assert len(yielded_events) == 0


# ============================================================================
# 4. Unvalidated Tool Output Block
# ============================================================================


@pytest.mark.asyncio
async def test_unvalidated_tool_output_tool_blocked_flag_raises_projection_blocked() -> None:
    """When output has tool_blocked=True, raises ProjectionBlockedException with GUARDRAIL_TOOL_SCHEMA."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "tool_blocked": True,
                    "tool_block_response_key": GUARDRAIL_TOOL_SCHEMA,
                }
            },
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    yielded_events: list[ChatTurnEvent] = []

    with pytest.raises(ProjectionBlockedException) as exc_info:
        async for event in interpreter.interpret(stream, context=context):
            yielded_events.append(event)

    assert exc_info.value.error_code == GUARDRAIL_TOOL_SCHEMA
    mock_resolver.resolve.assert_not_called()
    assert len(yielded_events) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "additional_kwargs",
    [
        {},
        {"guardrail_validated": False},
        {"guardrail_validated": None},
        {"other_key": True},
    ],
)
async def test_unvalidated_tool_output_missing_guardrail_validated_flag_raises_blocked(
    additional_kwargs: dict[str, object],
) -> None:
    """ToolMessage without guardrail_validated=True raises ProjectionBlockedException(GUARDRAIL_TOOL_SCHEMA)."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "tools",
            "data": {
                "output": {
                    "messages": [
                        ToolMessage(
                            content="raw output",
                            tool_call_id="call_unvalidated",
                            name="search_flights",
                            additional_kwargs=additional_kwargs,
                        )
                    ]
                }
            },
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    yielded_events: list[ChatTurnEvent] = []

    with pytest.raises(ProjectionBlockedException) as exc_info:
        async for event in interpreter.interpret(stream, context=context):
            yielded_events.append(event)

    assert exc_info.value.error_code == GUARDRAIL_TOOL_SCHEMA
    mock_resolver.resolve.assert_not_called()
    assert len(yielded_events) == 0


# ============================================================================
# 5. Handoff Node Completions
# ============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "node_name",
    [
        "create_handoff_token",
        "create_handoff_token_node",
        "validate_handoff",
    ],
)
async def test_handoff_node_completion_emits_action_handoff_event(node_name: str) -> None:
    """Chain end of handoff nodes forwards output to resolver and yields ActionHandoffEvent."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    handoff_event = ActionHandoffEvent(
        data=ActionHandoffPayload(
            version=1,
            action="begin_checkout",
            handoffToken="tok_handoff_123",
            expiresAt="2026-09-25T12:00:00Z",
            display={"summary": "Flight booking"},
        )
    )
    mock_resolver.resolve_handoff_node = MagicMock(
        return_value=HandoffResolution(
            is_blocked=False,
            handoff_event=handoff_event,
            force_persistence=True,
        )
    )

    output_payload = {
        "action": {
            "action": "begin_checkout",
            "handoffToken": "tok_handoff_123",
            "expiresAt": "2026-09-25T12:00:00Z",
        }
    }

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": node_name,
            "data": {"output": output_payload},
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    mock_resolver.resolve_handoff_node.assert_called_once_with(node_name, output_payload, context)
    assert len(events) == 1
    assert isinstance(events[0], ActionHandoffEvent)
    assert events[0] is handoff_event


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "node_name",
    [
        "create_handoff_token",
        "create_handoff_token_node",
        "validate_handoff",
    ],
)
async def test_handoff_node_completion_blocked_raises_projection_blocked(node_name: str) -> None:
    """Blocked handoff resolution raises ProjectionBlockedException with error_code=HANDOFF_FAILED."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve_handoff_node = MagicMock(
        return_value=HandoffResolution(
            is_blocked=True,
            error_code="HANDOFF_FAILED",
            error_message="Checkout handoff could not be created.",
            error_detail="Handoff token expired or invalid",
        )
    )

    output_payload = {"action": {"error": "Handoff token expired or invalid"}}

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": node_name,
            "data": {"output": output_payload},
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    yielded_events: list[ChatTurnEvent] = []

    with pytest.raises(ProjectionBlockedException) as exc_info:
        async for event in interpreter.interpret(stream, context=context):
            yielded_events.append(event)

    assert exc_info.value.error_code == "HANDOFF_FAILED"
    assert exc_info.value.error_message == "Checkout handoff could not be created."
    assert exc_info.value.error_detail == "Handoff token expired or invalid"
    assert len(yielded_events) == 0


@pytest.mark.asyncio
async def test_handoff_node_completion_no_event_yields_nothing() -> None:
    """When handoff resolution has is_blocked=False and handoff_event=None, nothing is yielded."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve_handoff_node = MagicMock(
        return_value=HandoffResolution(
            is_blocked=False,
            handoff_event=None,
            force_persistence=False,
        )
    )

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "create_handoff_token",
            "data": {"output": {}},
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 0


@pytest.mark.asyncio
async def test_non_handoff_node_does_not_route_to_resolve_handoff_node() -> None:
    """Nodes outside the handoff set do not trigger resolve_handoff_node."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve_handoff_node = MagicMock()

    stream = to_stream(
        {
            "event": "on_chain_end",
            "name": "random_other_node",
            "data": {"output": {"action": {"handoffToken": "tok"}}},
        }
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    mock_resolver.resolve_handoff_node.assert_not_called()
    assert len(events) == 0


# ============================================================================
# 6. Model Stream, Fallback & Deduplication
# ============================================================================


@pytest.mark.asyncio
async def test_model_stream_emits_raw_token_chunks() -> None:
    """Incremental tokens via on_chat_model_stream emit raw TokenEvent chunks."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    stream = to_stream(
        {"event": "on_chat_model_start", "name": "chat_model"},
        {
            "event": "on_chat_model_stream",
            "run_id": "run-stream-1",
            "data": {"chunk": MagicMock(content="Hello ")},
        },
        {
            "event": "on_chat_model_stream",
            "run_id": "run-stream-1",
            "data": {"chunk": MagicMock(content="world!")},
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 2
    assert isinstance(events[0], TokenEvent)
    assert events[0].data.content == "Hello "
    assert isinstance(events[1], TokenEvent)
    assert events[1].data.content == "world!"


@pytest.mark.asyncio
async def test_model_stream_fallback_to_on_chat_model_end_when_stream_empty() -> None:
    """When no tokens were streamed, on_chat_model_end message content is emitted as TokenEvent."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    stream = to_stream(
        {"event": "on_chat_model_start", "name": "chat_model"},
        {
            "event": "on_chat_model_end",
            "run_id": "run-nostream-1",
            "data": {"output": AIMessage(content="Fallback from model end")},
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 1
    assert isinstance(events[0], TokenEvent)
    assert events[0].data.content == "Fallback from model end"


@pytest.mark.asyncio
async def test_model_stream_fallback_to_final_node_output_when_stream_and_model_end_empty() -> None:
    """When stream and model-end are empty, final node output message content is emitted as TokenEvent."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    stream = to_stream(
        {"event": "on_chain_start", "name": "final_answer"},
        {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {
                "output": {"messages": [AIMessage(content="Fallback from final node output")]}
            },
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 1
    assert isinstance(events[0], TokenEvent)
    assert events[0].data.content == "Fallback from final node output"


@pytest.mark.asyncio
async def test_model_stream_deduplication_streamed_tokens_not_re_emitted_by_fallbacks() -> None:
    """If tokens were already streamed, on_chat_model_end and final node output do NOT duplicate tokens."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    completed_msg = AIMessage(
        content="Chunk 1 and Chunk 2",
        id="msg-completed-1",
    )

    stream = to_stream(
        {"event": "on_chain_start", "name": "travel"},
        {"event": "on_chat_model_start", "name": "chat_model"},
        {
            "event": "on_chat_model_stream",
            "run_id": "run-dedup-1",
            "data": {"chunk": MagicMock(content="Chunk 1 and ")},
        },
        {
            "event": "on_chat_model_stream",
            "run_id": "run-dedup-1",
            "data": {"chunk": MagicMock(content="Chunk 2")},
        },
        {
            "event": "on_chat_model_end",
            "run_id": "run-dedup-1",
            "data": {"output": completed_msg},
        },
        {
            "event": "on_chain_end",
            "name": "travel",
            "data": {"output": {"messages": [completed_msg]}},
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    # Exactly the two streamed tokens should be emitted, zero duplicates from end events
    assert len(events) == 2
    assert [e.data.content for e in events if isinstance(e, TokenEvent)] == [
        "Chunk 1 and ",
        "Chunk 2",
    ]


@pytest.mark.asyncio
async def test_model_stream_deduplication_model_end_fallback_not_duplicated_by_node_end() -> None:
    """When model-end fallback emits a message, subsequent node end output does NOT duplicate it."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)

    completed_msg = AIMessage(
        content="Model-end single message",
        id="msg-completed-2",
    )

    stream = to_stream(
        {"event": "on_chain_start", "name": "final_answer"},
        {"event": "on_chat_model_start", "name": "chat_model"},
        {
            "event": "on_chat_model_end",
            "run_id": "run-fallback-dedup",
            "data": {"output": completed_msg},
        },
        {
            "event": "on_chain_end",
            "name": "final_answer",
            "data": {"output": {"messages": [completed_msg]}},
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    # Only 1 token event emitted from model-end fallback
    assert len(events) == 1
    assert isinstance(events[0], TokenEvent)
    assert events[0].data.content == "Model-end single message"


# ============================================================================
# 7. Timing-Only on_tool_end
# ============================================================================


@pytest.mark.asyncio
async def test_on_tool_end_yields_zero_domain_events() -> None:
    """on_tool_end is purely for timing telemetry and yields zero domain events without invoking resolver."""
    context = FakeTurnContext()
    mock_resolver = MagicMock(spec=ToolResultResolver)
    mock_resolver.resolve = AsyncMock()

    stream = to_stream(
        {
            "event": "on_tool_start",
            "name": "search_flights",
            "data": {"input": {"origin": "SFO", "destination": "JFK"}},
        },
        {
            "event": "on_tool_end",
            "name": "search_flights",
            "data": {"output": '{"flights": []}'},
        },
    )

    interpreter = GraphEventInterpreter(resolver=mock_resolver, context=context)
    events = await collect_events(interpreter, stream, context=context)

    assert len(events) == 0
    mock_resolver.resolve.assert_not_called()
