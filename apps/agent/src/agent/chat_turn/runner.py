import asyncio
import json
import logging
from typing import Any, AsyncIterator, Callable, Dict, Optional

from agent.agents.chat_agent import format_messages
from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionRequiredEvent,
    ChatTurnEvent,
    DoneEvent,
    DonePayload,
    ErrorEvent,
    ErrorPayload,
    FlightResultsEvent,
    TokenEvent,
    TokenPayload,
    ToolCallEvent,
    ToolResultEvent,
)
from agent.chat_turn.interpreter import GraphEventInterpreter, ProjectionBlockedException
from agent.chat_turn.resolver import ToolResultResolver
from agent.config import get_settings
from agent.guardrails.base import (
    AdmissionContext,
    OutputGuardrailBlockedError,
    ValidatedInput,
)
from agent.guardrails.gateway import OutputStreamSession
from agent.guardrails.output_pipeline import (
    payload_free_config,
)
from agent.infrastructure.redis import get_redis_client
from agent.memory.manager import MemoryManager
from agent.observability.chat_observability import ChatTelemetry, safe_opaque_id
from agent.tools.nestjs_client import NestJSClient
from agent.trusted_search_snapshot import (
    SnapshotOwner,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

logger = logging.getLogger("agent.chat_turn.runner")
guardrails_logger = logging.getLogger("agent.guardrails")

background_tasks: set[asyncio.Task] = set()


async def _persist_response(
    client: Any,
    session_id: str,
    user_msg: str,
    response_text: str,
    user_already_persisted: bool = False,
    use_shield: bool = False,
    queue_manager: Any = None,
) -> Dict[str, Any]:
    """
    Persists the user and agent messages as a batch.
    Revalidates active fence if queue_manager is provided before performing persistence.
    Returns the batch result dictionary.
    """
    if queue_manager is not None:
        is_valid = await queue_manager.validate_active_fence(session_id)
        if not is_valid:
            logger.warning("stale_fence_persistence_aborted")
            raise RuntimeError("Session fence is no longer active")

    if user_already_persisted:
        payload = [{"sender": "AGENT", "type": "STANDARD", "content": response_text}]
    else:
        payload = [
            {"sender": "USER", "type": "STANDARD", "content": user_msg},
            {"sender": "AGENT", "type": "STANDARD", "content": response_text},
        ]
    return await client.create_message_batch(session_id, payload)


class ChatTurnRunner:
    """
    Transport-agnostic execution runner for a single chat turn.
    Manages session lifecycle, distributed fencing, LangGraph streaming,
    output guardrails, persistence, and telemetry.
    """

    def __init__(
        self,
        settings: Any = None,
        graph: Any = None,
        guardrails: Any = None,
        queue_manager: Any = None,
        redis_client: Any = None,
        client_factory: Optional[Callable[..., Any]] = None,
        telemetry: Any = None,
        gateway: Optional[Any] = None,
        require_gateway: bool = False,
    ):
        self._settings = settings
        self._graph = graph
        self._guardrails = guardrails
        self._queue_manager = queue_manager
        self._redis_client = redis_client
        self._client_factory = client_factory
        self._telemetry = telemetry
        self.gateway = gateway
        self.require_gateway = require_gateway

    @property
    def settings(self) -> Any:
        if self._settings is None:
            return get_settings()
        return self._settings

    @property
    def graph(self) -> Any:
        if self._graph is None:
            from agent.graph.graph import graph

            return graph
        return self._graph

    @property
    def telemetry(self) -> Any:
        if self._telemetry is None:
            return ChatTelemetry(logger)
        return self._telemetry

    def _get_redis_client(self) -> Any:
        if self._redis_client is not None:
            return self._redis_client
        try:
            return get_redis_client()
        except Exception:
            return None

    def _create_client(
        self,
        token: str,
        trace_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> Any:
        base_url = self.settings.NESTJS_API_URL
        if self._client_factory is not None:
            try:
                client = self._client_factory(
                    base_url=base_url,
                    token=token,
                    trace_id=trace_id,
                    correlation_id=correlation_id,
                )
            except TypeError:
                client = self._client_factory(base_url, token)
            if hasattr(client, "trace_id"):
                client.trace_id = trace_id
            if hasattr(client, "correlation_id"):
                client.correlation_id = correlation_id
            return client
        return NestJSClient(
            base_url=base_url,
            token=token,
            trace_id=trace_id,
            correlation_id=correlation_id,
        )

    async def _finalize_cleanup(
        self,
        *,
        session_id: Optional[str],
        req_id: Optional[str],
        queue_manager: Any,
        client: Any,
        pipeline: Optional[OutputStreamSession],
        partial_response: str,
        user_msg_content: str,
        user_msg_persisted: bool,
        persisted: bool,
        use_shield: bool = False,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        error_detail: Optional[str] = None,
    ) -> tuple[bool, Optional[str], Optional[ErrorEvent]]:
        """
        Deterministic causal failure cleanup ordering:
        1. Persist partial turn if tokens were emitted and fence is valid (asyncio.shield if cancelled).
        2. Finalize / close output guardrail pipeline (pipeline.aclose()).
        3. Release owned session lease (queue_manager.release(session_id, req_id)).
        4. Construct terminal ErrorEvent if caller still attached.
        """
        partial_message_id = None
        new_persisted = persisted

        # 1. Persist partial turn if tokens were emitted and not yet persisted
        if (
            not persisted
            and partial_response
            and partial_response.strip()
            and client is not None
            and session_id is not None
        ):
            try:
                fence_valid = True
                if queue_manager is not None:
                    fence_valid = await asyncio.wait_for(
                        queue_manager.validate_active_fence(session_id),
                        timeout=1.0,
                    )
                if fence_valid:
                    batch_res = await asyncio.wait_for(
                        _persist_response(
                            client=client,
                            session_id=session_id,
                            user_msg=user_msg_content,
                            response_text=partial_response,
                            user_already_persisted=user_msg_persisted,
                            use_shield=use_shield,
                            queue_manager=queue_manager,
                        ),
                        timeout=3.0,
                    )
                    new_persisted = True
                    for msg in batch_res.get("messages", []):
                        if msg.get("sender") == "AGENT":
                            partial_message_id = msg.get("id")
                else:
                    logger.warning("stale_fence_partial_persistence_aborted")
            except Exception:  # noqa: BLE001
                logger.error("cleanup_partial_persistence_failed")

        # 2. Finalize / close output guardrail pipeline
        if pipeline is not None and not getattr(pipeline, "closed", False):
            try:
                if hasattr(pipeline, "aclose"):
                    await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
                elif hasattr(pipeline, "close"):
                    pipeline.close()
            except Exception:  # noqa: BLE001
                logger.warning("guardrail_pipeline_close_failed")

        # 3. Release owned session lease
        if queue_manager is not None and session_id is not None and req_id is not None:
            try:
                await asyncio.wait_for(queue_manager.release(session_id, req_id), timeout=2.0)
            except Exception:  # noqa: BLE001
                logger.error("session_lease_release_failed")

        # 4. Construct terminal ErrorEvent if error_code is provided
        error_event = None
        if error_code is not None:
            error_event = ErrorEvent(
                data=ErrorPayload(
                    code=error_code,
                    message=error_message or "An unexpected error occurred.",
                    partialMessageId=partial_message_id,
                    error=error_detail,
                )
            )

        return new_persisted, partial_message_id, error_event

    async def run(
        self,
        command: ChatTurnCommand,
        validated_input: Optional[ValidatedInput] = None,
    ) -> AsyncIterator[ChatTurnEvent]:
        """
        Execute a single chat turn as an async generator yielding ChatTurnEvent items.
        """
        require_gw = bool(self.require_gateway)
        if not require_gw and self._settings is not None:
            setting_val = getattr(self._settings, "REQUIRE_GUARDRAIL_GATEWAY", None)
            if isinstance(setting_val, bool):
                require_gw = setting_val
            elif isinstance(setting_val, str):
                require_gw = setting_val.lower() in ("true", "1", "yes")

        if require_gw and self.gateway is None:
            yield ErrorEvent(
                data=ErrorPayload(
                    code="GUARDRAIL_CONFIGURATION_ERROR",
                    message=(
                        "Chat execution rejected: mandatory guardrail gateway is absent "
                        "or unconfigured."
                    ),
                )
            )
            return

        settings = self.settings
        telemetry = self.telemetry
        queue_manager = self._queue_manager
        guardrails = self._guardrails
        redis_client = self._get_redis_client()
        graph = self.graph

        trace_id = safe_opaque_id(command.trace_id)
        correlation_id = safe_opaque_id(command.correlation_id)

        if validated_input is None and self.gateway is not None and command.message:
            context = AdmissionContext(
                user_id=command.user_id,
                chat_session_id=command.session_id or "unassigned",
                trace_id=command.trace_id or "trace-default",
                correlation_id=command.correlation_id,
                policy_version="2026-09-05",
            )
            try:
                decision = await self.gateway.validate_input(context, command.message)
            except Exception:
                yield ErrorEvent(
                    data=ErrorPayload(
                        code="GUARDRAIL_INPUT_INJECTION",
                        message="Input rejected by security guardrail: GUARDRAIL_INPUT_INJECTION",
                    )
                )
                return

            if decision.status == "BLOCK":
                code = decision.response_key or "GUARDRAIL_INPUT_BLOCKED"
                yield ErrorEvent(
                    data=ErrorPayload(
                        code=code,
                        message=f"Input rejected by security guardrail: {code}",
                    )
                )
                return
            validated_input = decision.validated_data

        client = self._create_client(
            token=command.token,
            trace_id=trace_id,
            correlation_id=correlation_id,
        )

        session_id = command.session_id
        req_id: Optional[str] = None
        released = False
        pipeline: Optional[OutputStreamSession] = None
        partial_response = ""
        user_msg_persisted = False
        persisted = False
        force_persistence = False
        user_msg_content = (
            validated_input.content
            if validated_input is not None
            else (command.message or "Action confirmed")
        )

        try:
            # 1. Session resolution / auto-creation
            if not session_id:
                try:
                    session_data = await client.create_session(title=None)
                    session_id = session_data.get("id") or session_data.get("sessionId")
                except Exception:
                    logger.error("nestjs_session_creation_failed")
                    yield ErrorEvent(
                        data=ErrorPayload(
                            code="PERSISTENCE_ERROR",
                            message="Failed to initialize chat session.",
                            partialMessageId=None,
                        )
                    )
                    return

            # 2. Fenced session lease acquisition
            if queue_manager is not None:
                try:
                    req_id = await queue_manager.acquire(session_id, user_id=command.user_id)
                    fence = queue_manager.get_fence(session_id)
                    client.set_fencing_token(fence)
                except Exception:
                    logger.error("session_lock_acquisition_failed")
                    yield ErrorEvent(
                        data=ErrorPayload(
                            code="PERSISTENCE_ERROR",
                            message="Could not acquire session lock.",
                            partialMessageId=None,
                        )
                    )
                    return

            # 3. Memory context fetch
            try:
                memory_window = getattr(settings, "MEMORY_WINDOW_SIZE", 20)
                memory_data = await client.get_memory(session_id, recent_count=memory_window)
                history = (
                    memory_data.get("recentMessages", []) if isinstance(memory_data, dict) else []
                )
                summary = (
                    memory_data.get("summary", None) if isinstance(memory_data, dict) else None
                )
            except Exception as e:
                logger.error("nestjs_memory_fetch_failed")
                err_msg = str(e)
                if "NOT_FOUND" in err_msg or "404" in err_msg:
                    code = "CHAT_SESSION_NOT_FOUND"
                    msg = "Chat session not found."
                else:
                    code = "PERSISTENCE_ERROR"
                    msg = "Failed to fetch chat session memory."
                _, _, err_event = await self._finalize_cleanup(
                    session_id=session_id,
                    req_id=req_id,
                    queue_manager=queue_manager,
                    client=client,
                    pipeline=None,
                    partial_response=partial_response,
                    user_msg_content=user_msg_content,
                    user_msg_persisted=user_msg_persisted,
                    persisted=persisted,
                    error_code=code,
                    error_message=msg,
                )
                pipeline = None
                req_id = None
                released = True
                if err_event:
                    yield err_event
                return

            mem_context = AdmissionContext(
                user_id=command.user_id,
                chat_session_id=session_id or "unassigned",
                trace_id=command.trace_id or "trace-default",
                correlation_id=command.correlation_id,
                policy_version="2026-09-05",
            )
            if self.gateway is not None:
                if summary:
                    summary_content = (
                        summary.get("content")
                        if isinstance(summary, dict)
                        else (getattr(summary, "content", None) or str(summary))
                    )
                    if isinstance(summary, str):
                        summary_content = summary
                    try:
                        summary_decision = await self.gateway.validate_input(
                            mem_context, summary_content
                        )
                        if summary_decision.status == "BLOCK":
                            logger.warning(
                                "Unsafe persisted summary discarded by guardrail gateway: %s",
                                summary_decision.response_key,
                            )
                            summary = None
                    except Exception:
                        logger.warning(
                            "Exception validating persisted summary; discarding summary."
                        )
                        summary = None

                for msg in history:
                    msg_content = (
                        msg.get("content")
                        if isinstance(msg, dict)
                        else (getattr(msg, "content", None) or str(msg))
                    )
                    if not msg_content or not isinstance(msg_content, str):
                        continue
                    try:
                        history_decision = await self.gateway.validate_input(
                            mem_context, msg_content
                        )
                    except Exception:
                        history_decision = None

                    if history_decision is None or history_decision.status == "BLOCK":
                        block_code = (
                            history_decision.response_key
                            if history_decision and history_decision.response_key
                            else "GUARDRAIL_INPUT_INJECTION"
                        )
                        logger.warning(
                            "Unsafe historical conversation context blocked by guardrail gateway: %s",
                            block_code,
                        )
                        _, _, err_event = await self._finalize_cleanup(
                            session_id=session_id,
                            req_id=req_id,
                            queue_manager=queue_manager,
                            client=client,
                            pipeline=None,
                            partial_response=partial_response,
                            user_msg_content=user_msg_content,
                            user_msg_persisted=user_msg_persisted,
                            persisted=persisted,
                            error_code=block_code,
                            error_message="Historical conversation context contains unsafe content.",
                        )
                        pipeline = None
                        req_id = None
                        released = True
                        if err_event:
                            yield err_event
                        return

            # 4. TrustedSearchSnapshot loading via lifecycle + telemetry emit
            trusted_snapshot_dict = None
            snapshot_state = "miss"
            if redis_client is not None:
                try:
                    owner = SnapshotOwner(user_id=command.user_id, chat_session_id=session_id)
                    repo = TrustedSnapshotRepository(redis_client)
                    lifecycle = TrustedSearchSnapshotLifecycle(repo)
                    snapshot_obj = await lifecycle.load_active(owner)
                    if snapshot_obj:
                        trusted_snapshot_dict = snapshot_obj.model_dump(mode="json")
                        snapshot_state = "hit"
                except Exception:
                    logger.debug("trusted_snapshot_lookup_failed")
                    snapshot_state = "unavailable"
            else:
                snapshot_state = "unavailable"

            telemetry.emit_safely(
                "snapshot_read",
                status=snapshot_state,
                trace_id=trace_id,
                correlation_id=correlation_id,
                fields={"outcome": snapshot_state},
            )

            output_config = getattr(settings, "output_guardrail", None)
            if self.gateway is not None:
                pipeline = self.gateway.stream_output(
                    context=mem_context,
                    config=output_config,
                    session_id=session_id,
                )
            else:
                pipeline = OutputStreamSession(
                    context=mem_context,
                    config=output_config,
                    session_id=session_id,
                )

            # 6. User message pre-persistence
            if command.message:
                if queue_manager and not await queue_manager.validate_active_fence(session_id):
                    logger.warning("stale_fence_pre_persistence_aborted")
                    _, _, err_event = await self._finalize_cleanup(
                        session_id=session_id,
                        req_id=req_id,
                        queue_manager=queue_manager,
                        client=client,
                        pipeline=pipeline,
                        partial_response=partial_response,
                        user_msg_content=user_msg_content,
                        user_msg_persisted=user_msg_persisted,
                        persisted=persisted,
                        error_code="PERSISTENCE_ERROR",
                        error_message="The session lease was lost.",
                    )
                    pipeline = None
                    req_id = None
                    released = True
                    if err_event:
                        yield err_event
                    return

                try:
                    await client.create_message_batch(
                        session_id,
                        [{"sender": "USER", "type": "STANDARD", "content": command.message}],
                    )
                    user_msg_persisted = True
                except Exception:
                    logger.warning("user_message_persistence_failed")
                    _, _, err_event = await self._finalize_cleanup(
                        session_id=session_id,
                        req_id=req_id,
                        queue_manager=queue_manager,
                        client=client,
                        pipeline=pipeline,
                        partial_response=partial_response,
                        user_msg_content=user_msg_content,
                        user_msg_persisted=user_msg_persisted,
                        persisted=persisted,
                        error_code="PERSISTENCE_ERROR",
                        error_message="Failed to persist user message before tool execution.",
                    )
                    pipeline = None
                    req_id = None
                    released = True
                    if err_event:
                        yield err_event
                    return

            # 7. LangGraph execution & streaming
            config = {
                "configurable": {
                    "thread_id": session_id,
                    "user_id": command.user_id,
                    "nestjs_client": client,
                    "trusted_snapshot": trusted_snapshot_dict,
                    "guardrail_gateway": self.gateway,
                }
            }
            messages = format_messages(
                history=history,
                current_message=command.message or "",
                summary=summary,
            )
            initial_state: Dict[str, Any] = {
                "messages": messages,
                "iteration_count": 0,
                "pending_confirmation": None,
                "handoff_required": False,
                "trusted_snapshot": trusted_snapshot_dict,
            }
            if command.action_required:
                initial_state["action_required"] = command.action_required
            if command.action_type:
                initial_state["action_type"] = command.action_type
            if command.action_payload:
                initial_state["action_payload"] = command.action_payload

            config = payload_free_config(config)
            event_stream = graph.astream_events(
                initial_state,
                config=config,
                version="v2",
            )

            snapshot_lifecycle = (
                TrustedSearchSnapshotLifecycle(TrustedSnapshotRepository(redis_client))
                if redis_client is not None
                else None
            )
            resolver = ToolResultResolver(snapshot_lifecycle=snapshot_lifecycle)
            turn_context: dict[str, object] = {
                "user_id": command.user_id,
                "session_id": session_id,
                "redis_client": redis_client,
                "snapshot_lifecycle": snapshot_lifecycle,
                "telemetry": telemetry,
                "trace_id": trace_id,
                "correlation_id": correlation_id,
            }
            interpreter = GraphEventInterpreter(resolver=resolver, context=turn_context)

            try:
                async for event in interpreter.interpret(event_stream, context=turn_context):
                    if isinstance(event, TokenEvent):
                        token_content = event.data.content
                        async for safe_chunk in pipeline.process_token(token_content):
                            partial_response += safe_chunk
                            yield TokenEvent(data=TokenPayload(content=safe_chunk))

                    elif isinstance(event, (ToolCallEvent, ToolResultEvent, FlightResultsEvent)):
                        yield event

                    elif isinstance(event, ActionRequiredEvent):
                        if queue_manager and not await queue_manager.validate_active_fence(
                            session_id
                        ):
                            logger.warning("stale_fence_action_required_emission_aborted")
                            _, _, err_event = await self._finalize_cleanup(
                                session_id=session_id,
                                req_id=req_id,
                                queue_manager=queue_manager,
                                client=client,
                                pipeline=pipeline,
                                partial_response=partial_response,
                                user_msg_content=user_msg_content,
                                user_msg_persisted=user_msg_persisted,
                                persisted=persisted,
                                error_code="PERSISTENCE_ERROR",
                                error_message=(
                                    "The requested action could not be emitted because "
                                    "the session lease was lost."
                                ),
                            )
                            pipeline = None
                            req_id = None
                            released = True
                            if err_event:
                                yield err_event
                            return

                        yield event
                        if pipeline is not None:
                            try:
                                await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
                            except Exception:
                                logger.warning("guardrail_pipeline_close_failed")
                            pipeline = None
                        if queue_manager is not None and req_id is not None and not released:
                            released = True
                            try:
                                await asyncio.wait_for(
                                    queue_manager.release(session_id, req_id),
                                    timeout=2.0,
                                )
                            except Exception:
                                logger.error("session_lease_release_failed")
                            req_id = None
                        return

                    elif isinstance(event, ActionHandoffEvent):
                        if queue_manager and not await queue_manager.validate_active_fence(
                            session_id
                        ):
                            logger.warning("stale_fence_handoff_emission_aborted")
                            _, _, err_event = await self._finalize_cleanup(
                                session_id=session_id,
                                req_id=req_id,
                                queue_manager=queue_manager,
                                client=client,
                                pipeline=pipeline,
                                partial_response=partial_response,
                                user_msg_content=user_msg_content,
                                user_msg_persisted=user_msg_persisted,
                                persisted=persisted,
                                error_code="PERSISTENCE_ERROR",
                                error_message=(
                                    "The requested action could not be emitted because "
                                    "the session lease was lost."
                                ),
                            )
                            pipeline = None
                            req_id = None
                            released = True
                            if err_event:
                                yield err_event
                            return

                        yield event
                        telemetry.emit_safely(
                            "handoff_create",
                            status="created",
                            trace_id=trace_id,
                            correlation_id=correlation_id,
                            fields={"outcome": "created"},
                        )
                        force_persistence = True

            except ProjectionBlockedException as exc:
                if exc.error_code == "HANDOFF_FAILED":
                    telemetry.emit_safely(
                        "handoff_create",
                        status="rejected",
                        trace_id=trace_id,
                        correlation_id=correlation_id,
                        fields={
                            "outcome": "rejected",
                            "error_class": "handoff_rejected",
                        },
                    )
                _, _, err_event = await self._finalize_cleanup(
                    session_id=session_id,
                    req_id=req_id,
                    queue_manager=queue_manager,
                    client=client,
                    pipeline=pipeline,
                    partial_response=partial_response,
                    user_msg_content=user_msg_content,
                    user_msg_persisted=user_msg_persisted,
                    persisted=persisted,
                    error_code=exc.error_code,
                    error_message=exc.error_message,
                    error_detail=exc.error_detail,
                )
                pipeline = None
                req_id = None
                released = True
                if err_event:
                    yield err_event
                return

            # Flush output guardrail pipeline
            async for safe_chunk in pipeline.flush():
                partial_response += safe_chunk
                yield TokenEvent(data=TokenPayload(content=safe_chunk))

            # Completed turn - Persist message batch and send done event
            if partial_response.strip() or force_persistence:
                if queue_manager and not await queue_manager.validate_active_fence(session_id):
                    logger.warning("stale_fence_completed_persistence_aborted")
                    _, _, err_event = await self._finalize_cleanup(
                        session_id=session_id,
                        req_id=req_id,
                        queue_manager=queue_manager,
                        client=client,
                        pipeline=pipeline,
                        partial_response=partial_response,
                        user_msg_content=user_msg_content,
                        user_msg_persisted=user_msg_persisted,
                        persisted=persisted,
                        error_code="PERSISTENCE_ERROR",
                        error_message="The response was generated but could not be saved.",
                    )
                    pipeline = None
                    req_id = None
                    released = True
                    if err_event:
                        yield err_event
                    return

                try:
                    batch_res = await _persist_response(
                        client=client,
                        session_id=session_id,
                        user_msg=user_msg_content,
                        response_text=partial_response,
                        user_already_persisted=user_msg_persisted,
                        queue_manager=queue_manager,
                    )
                    persisted = True
                except Exception:
                    logger.error("completed_response_persistence_failed")
                    _, _, err_event = await self._finalize_cleanup(
                        session_id=session_id,
                        req_id=req_id,
                        queue_manager=queue_manager,
                        client=client,
                        pipeline=pipeline,
                        partial_response=partial_response,
                        user_msg_content=user_msg_content,
                        user_msg_persisted=user_msg_persisted,
                        persisted=persisted,
                        error_code="PERSISTENCE_ERROR",
                        error_message="The response was generated but could not be saved.",
                    )
                    pipeline = None
                    req_id = None
                    released = True
                    if err_event:
                        yield err_event
                    return

                agent_message_id = None
                for msg in batch_res.get("messages", []):
                    if msg.get("sender") == "AGENT":
                        agent_message_id = msg.get("id")

                # Clean up pipeline and queue lease before yielding DoneEvent
                if pipeline is not None:
                    try:
                        await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
                    except Exception:
                        logger.warning("guardrail_pipeline_close_failed")
                    pipeline = None
                if queue_manager is not None and req_id is not None and not released:
                    released = True
                    try:
                        await asyncio.wait_for(
                            queue_manager.release(session_id, req_id), timeout=2.0
                        )
                    except Exception:
                        logger.error("session_lease_release_failed")
                    req_id = None

                yield DoneEvent(data=DonePayload(messageId=agent_message_id, sessionId=session_id))

                # Schedule non-blocking memory summarization
                memory_mgr = MemoryManager(
                    window_size=getattr(settings, "MEMORY_WINDOW_SIZE", 20),
                    token_budget=getattr(settings, "MEMORY_TOKEN_BUDGET", 4000),
                    gateway=self.gateway,
                )
                original_total = (
                    memory_data.get("totalMessageCount", 0) if isinstance(memory_data, dict) else 0
                )
                summarize_task = asyncio.create_task(
                    memory_mgr.check_and_summarize(
                        session_id, client, total_count=original_total + 2
                    )
                )
                background_tasks.add(summarize_task)
                summarize_task.add_done_callback(background_tasks.discard)
            else:
                logger.warning("empty_response_generated")
                if pipeline is not None:
                    try:
                        await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
                    except Exception:
                        logger.warning("guardrail_pipeline_close_failed")
                    pipeline = None
                if queue_manager is not None and req_id is not None and not released:
                    released = True
                    try:
                        await asyncio.wait_for(
                            queue_manager.release(session_id, req_id), timeout=2.0
                        )
                    except Exception:
                        logger.error("session_lease_release_failed")
                    req_id = None

        except OutputGuardrailBlockedError as e:
            if "event_stream" in locals() and hasattr(event_stream, "aclose"):
                await event_stream.aclose()
            guardrails_logger.warning(
                json.dumps(
                    {
                        "event": "security_block",
                        "session_id": session_id,
                        "guardrail_layer": e.layer,
                        "rule_name": e.rule,
                        "message": "LLM output blocked by guardrail",
                    }
                )
            )
            blocked_response = e.partial_response or partial_response
            _, _, err_event = await self._finalize_cleanup(
                session_id=session_id,
                req_id=req_id,
                queue_manager=queue_manager,
                client=client,
                pipeline=pipeline,
                partial_response=blocked_response,
                user_msg_content=user_msg_content,
                user_msg_persisted=user_msg_persisted,
                persisted=persisted,
                error_code="OUTPUT_GUARDRAIL_BLOCKED",
                error_message="Response was blocked for safety reasons.",
            )
            pipeline = None
            req_id = None
            released = True
            if err_event:
                yield err_event

        except (asyncio.CancelledError, GeneratorExit):
            logger.warning("chat_turn_cancelled")
            await self._finalize_cleanup(
                session_id=session_id,
                req_id=req_id,
                queue_manager=queue_manager,
                client=client,
                pipeline=pipeline,
                partial_response=partial_response,
                user_msg_content=user_msg_content,
                user_msg_persisted=user_msg_persisted,
                persisted=persisted,
                use_shield=True,
            )
            pipeline = None
            req_id = None
            released = True
            raise

        except Exception:
            logger.error("chat_turn_execution_failed", exc_info=True)
            _, _, err_event = await self._finalize_cleanup(
                session_id=session_id,
                req_id=req_id,
                queue_manager=queue_manager,
                client=client,
                pipeline=pipeline,
                partial_response=partial_response,
                user_msg_content=user_msg_content,
                user_msg_persisted=user_msg_persisted,
                persisted=persisted,
                error_code="LLM_ERROR",
                error_message="The AI model encountered an error. Please try again.",
            )

            pipeline = None
            req_id = None
            released = True
            if err_event:
                yield err_event

        finally:
            if pipeline is not None:
                try:
                    await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
                except Exception:
                    pass
            if queue_manager is not None and req_id is not None and not released:
                try:
                    await asyncio.wait_for(queue_manager.release(session_id, req_id), timeout=2.0)
                except Exception:
                    pass
