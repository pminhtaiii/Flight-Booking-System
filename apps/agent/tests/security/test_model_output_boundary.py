"""Model-dispatch and non-streamed output boundary contracts for T020."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from agent.agents.checkout_orchestrator import checkout_orchestrator_node
from agent.agents.general_agent import general_agent_node
from agent.agents.travel_assistant import travel_assistant_node
from agent.chat_turn import ChatTurnCommand
from agent.chat_turn.runner import ChatTurnRunner
from agent.graph.nodes import final_answer_node
from agent.graph.router import invoke_router
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.registry import create_production_registry
from agent.memory.manager import MemoryManager
from agent.models.requests import RouteDecision

OUTPUT_CANARY = "4111-1111-1111-1111"
CALLBACK_CANARY = "CALLBACK_CANARY_RAW_PAYLOAD_023"


class _CapturingModel:
    def __init__(self, response: object) -> None:
        self.response = response
        self.invocations: list[tuple[object, object]] = []

    def bind_tools(self, _tools: object) -> "_CapturingModel":
        return self

    def with_structured_output(self, _schema: object) -> "_CapturingModel":
        return self

    async def ainvoke(self, messages: object, config: object = None, **kwargs: object) -> object:
        effective_config = config if config is not None else kwargs.get("config")
        self.invocations.append((messages, effective_config))
        return self.response


def _assert_payload_free_dispatch(config: object, forbidden_callback: object | None = None) -> None:
    assert isinstance(config, dict)
    assert "callbacks" in config
    callbacks = config["callbacks"]
    if forbidden_callback is not None:
        assert forbidden_callback not in (callbacks or [])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "node,patch_target",
    [
        (general_agent_node, "agent.agents.general_agent.get_chat_model"),
        (travel_assistant_node, "agent.agents.travel_assistant.get_chat_model"),
        (checkout_orchestrator_node, "agent.agents.checkout_orchestrator.get_chat_model"),
        (final_answer_node, "agent.graph.nodes.get_chat_model"),
    ],
)
async def test_agent_model_paths_strip_caller_callbacks_and_do_not_export_unsafe_ai_message(
    node,
    patch_target: str,
) -> None:
    """Forwarding caller callbacks or raw AIMessage content leaks the output canary."""
    caller_callback = object()
    model = _CapturingModel(AIMessage(content=f"Sensitive output {OUTPUT_CANARY}"))
    gateway = GuardrailGateway(create_production_registry())
    config = {
        "callbacks": [caller_callback],
        "configurable": {
            "guardrail_gateway": gateway,
            "trace_id": "trace-model-boundary",
            "user_id": "user-model-boundary",
            "thread_id": "session-model-boundary",
        },
    }

    with patch(patch_target, return_value=model):
        result = await node({"messages": [HumanMessage(content="Find a flight")]}, config)

    assert len(model.invocations) == 1
    _assert_payload_free_dispatch(model.invocations[0][1], caller_callback)
    assert model.invocations[0][1]["configurable"]["trace_id"] == "trace-model-boundary"
    assert OUTPUT_CANARY not in repr(result)


@pytest.mark.asyncio
async def test_router_installs_explicit_payload_free_callbacks_before_dispatch() -> None:
    """Omitting an explicit callback policy permits environment tracing to capture prompts."""
    model = _CapturingModel(RouteDecision(intent="SEARCH", confidence=0.95, isCommitment=False))

    with patch("agent.graph.router.get_chat_model", return_value=model):
        decision = await invoke_router(
            {"messages": [HumanMessage(content=f"Find flights {CALLBACK_CANARY}")]}
        )

    assert decision.intent == "SEARCH"
    assert len(model.invocations) == 1
    _assert_payload_free_dispatch(model.invocations[0][1])


@pytest.mark.asyncio
async def test_runner_graph_dispatch_has_payload_free_callbacks_and_opaque_metadata() -> None:
    """Removing the runner callback policy re-enables raw graph event tracing."""
    captured: dict[str, object] = {}

    class EmptyGraph:
        async def astream_events(self, _state, *, config, version):
            captured["config"] = config
            captured["version"] = version
            if False:
                yield None

    client = MagicMock()
    client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    client.create_message_batch = AsyncMock(return_value={"messages": []})
    client.set_fencing_token = MagicMock()
    queue = MagicMock()
    queue.acquire = AsyncMock(return_value="request-model-boundary")
    queue.get_fence = MagicMock(return_value=9)
    queue.validate_active_fence = AsyncMock(return_value=True)
    queue.release = AsyncMock()
    settings = SimpleNamespace(
        NESTJS_API_URL="http://localhost:3001/api",
        REQUIRE_GUARDRAIL_GATEWAY=False,
        MEMORY_WINDOW_SIZE=20,
        MEMORY_TOKEN_BUDGET=4000,
        output_guardrail=SimpleNamespace(enabled=False),
    )
    runner = ChatTurnRunner(
        settings=settings,
        graph=EmptyGraph(),
        queue_manager=queue,
        redis_client=MagicMock(),
        client_factory=lambda **_kwargs: client,
    )

    _ = [
        event
        async for event in runner.run(
            ChatTurnCommand(
                user_id="user-model-boundary",
                session_id="session-model-boundary",
                message="Find flights",
                token="test-token",
                trace_id="trace-model-boundary",
            )
        )
    ]

    _assert_payload_free_dispatch(captured["config"])
    assert captured["config"]["configurable"]["thread_id"] == "session-model-boundary"
    assert captured["config"]["configurable"]["user_id"] == "user-model-boundary"


@pytest.mark.asyncio
async def test_unsafe_generated_summary_is_not_persisted_or_logged_and_uses_callback_policy(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Skipping summary validation or callback suppression leaks a generated canary."""
    model = _CapturingModel(AIMessage(content=f"Summary contains {OUTPUT_CANARY}"))
    gateway = GuardrailGateway(create_production_registry())
    manager = MemoryManager(window_size=2, token_budget=1, gateway=gateway)
    client = MagicMock()
    client.trace_id = "trace-summary-boundary"
    client.correlation_id = "correlation-summary-boundary"
    client.create_message = AsyncMock()
    client.get_memory = AsyncMock(
        side_effect=[
            {"totalMessageCount": 3},
            {
                "recentMessages": [
                    {"sender": "USER", "content": "Discuss flight times"},
                    {"sender": "AGENT", "content": "Safe reply"},
                    {"sender": "USER", "content": "Another safe question"},
                ],
                "summary": None,
            },
        ]
    )

    with caplog.at_level(logging.DEBUG):
        with patch("agent.memory.manager.get_chat_model", return_value=model):
            await manager.check_and_summarize("session-summary-boundary", client)

    client.create_message.assert_not_awaited()
    assert OUTPUT_CANARY not in "\n".join(record.getMessage() for record in caplog.records)
    assert len(model.invocations) == 1
    _assert_payload_free_dispatch(model.invocations[0][1])


@pytest.mark.asyncio
async def test_model_exception_payload_is_not_logged_or_exported() -> None:
    """Logging a raw model exception exposes provider payloads and secrets."""

    class FailingModel(_CapturingModel):
        async def ainvoke(
            self, messages: object, config: object = None, **kwargs: object
        ) -> object:
            self.invocations.append((messages, config))
            raise RuntimeError(f"provider echoed {CALLBACK_CANARY}")

    model = FailingModel(response=None)
    manager = MemoryManager(window_size=2, token_budget=1)
    client = MagicMock()
    client.create_message = AsyncMock()
    client.get_memory = AsyncMock(
        side_effect=[
            {"totalMessageCount": 3},
            {
                "recentMessages": [
                    {"sender": "USER", "content": "Safe history"},
                    {"sender": "AGENT", "content": "Safe reply"},
                    {"sender": "USER", "content": "Another safe question"},
                ],
                "summary": None,
            },
        ]
    )
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Capture()
    logger = logging.getLogger("agent.memory")
    logger.addHandler(handler)
    try:
        with patch("agent.memory.manager.get_chat_model", return_value=model):
            await manager.check_and_summarize("session-error-boundary", client)
    finally:
        logger.removeHandler(handler)

    assert CALLBACK_CANARY not in "\n".join(record.getMessage() for record in records)
    client.create_message.assert_not_awaited()
    assert len(model.invocations) == 1
    _assert_payload_free_dispatch(model.invocations[0][1])
