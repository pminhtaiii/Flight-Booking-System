import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator, Callable, Dict, Optional

from agent.agents.chat_agent import format_messages
from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.events import (
    ActionHandoffEvent,
    ActionHandoffPayload,
    ActionRequiredEvent,
    ActionRequiredPayload,
    ChatTurnEvent,
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
from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline
from agent.infrastructure.redis import get_redis_client
from agent.memory.manager import MemoryManager
from agent.observability.chat_observability import ChatTelemetry, safe_opaque_id, safe_tool_name
from agent.tools.nestjs_client import NestJSClient, validate_booking_readiness_response
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
    if use_shield:
        return await asyncio.shield(client.create_message_batch(session_id, payload))
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
    ):
        self._settings = settings
        self._graph = graph
        self._guardrails = guardrails
        self._queue_manager = queue_manager
        self._redis_client = redis_client
        self._client_factory = client_factory
        self._telemetry = telemetry

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
        pipeline: Optional[OutputGuardrailPipeline],
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
        if pipeline is not None:
            try:
                await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
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

    async def run(self, command: ChatTurnCommand) -> AsyncIterator[ChatTurnEvent]:
        """
        Execute a single chat turn as an async generator yielding ChatTurnEvent items.
        """
        settings = self.settings
        telemetry = self.telemetry
        queue_manager = self._queue_manager
        guardrails = self._guardrails
        redis_client = self._get_redis_client()
        graph = self.graph

        trace_id = safe_opaque_id(command.trace_id)
        correlation_id = safe_opaque_id(command.correlation_id)

        client = self._create_client(
            token=command.token,
            trace_id=trace_id,
            correlation_id=correlation_id,
        )

        session_id = command.session_id
        req_id: Optional[str] = None
        released = False
        pipeline: Optional[OutputGuardrailPipeline] = None
        partial_response = ""
        user_msg_persisted = False
        persisted = False
        force_persistence = False
        user_msg_content = command.message or "Action confirmed"

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

            # 5. Output guardrails initialization
            output_config = getattr(settings, "output_guardrail", None)
            pipeline = OutputGuardrailPipeline(
                config=output_config,
                nemo_service=guardrails,
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

            event_stream = graph.astream_events(
                initial_state,
                config=config,
                version="v2",
            )

            tool_started_at: Dict[str, float] = {}

            async for event in event_stream:
                kind = event.get("event")

                if kind == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    if chunk and hasattr(chunk, "content") and chunk.content:
                        token_content = str(chunk.content)
                        async for safe_chunk in pipeline.process_token(token_content):
                            partial_response += safe_chunk
                            yield TokenEvent(data=TokenPayload(content=safe_chunk))

                elif kind == "on_tool_start":
                    tool_name = event.get("name")
                    tool_input = event.get("data", {}).get("input")
                    if isinstance(tool_name, str):
                        tool_started_at[tool_name] = time.perf_counter()

                    if tool_name == "check_booking_readiness":
                        safe_input = {"message": "Checking booking readiness..."}
                        yield ToolCallEvent(data=ToolCallPayload(name=tool_name, inputs=safe_input))
                    else:
                        yield ToolCallEvent(
                            data=ToolCallPayload(
                                name=tool_name or "",
                                inputs=tool_input if isinstance(tool_input, dict) else {},
                            )
                        )

                elif kind == "on_chain_end":
                    node_name = event.get("name")
                    if node_name in (
                        "create_handoff_token",
                        "create_handoff_token_node",
                        "validate_handoff",
                    ):
                        output = event.get("data", {}).get("output") or {}
                        action_res = output.get("action", {}) if isinstance(output, dict) else {}
                        if isinstance(action_res, dict) and "error" in action_res:
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
                            err_msg = (
                                action_res.get("error") or "Checkout handoff could not be created."
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
                                error_code="HANDOFF_FAILED",
                                error_message=err_msg,
                                error_detail=err_msg,
                            )
                            pipeline = None
                            req_id = None
                            released = True
                            if err_event:
                                yield err_event
                            return

                        if isinstance(action_res, dict):
                            handoff_token = action_res.get("handoffToken") or action_res.get(
                                "token"
                            )
                            action_type = action_res.get("action")
                            if handoff_token and action_type == "begin_checkout":
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
                                        error_message="The requested action could not be emitted because the session lease was lost.",
                                    )
                                    pipeline = None
                                    req_id = None
                                    released = True
                                    if err_event:
                                        yield err_event
                                    return

                                payload = ActionHandoffPayload(
                                    version=1,
                                    action="begin_checkout",
                                    handoffToken=handoff_token,
                                    expiresAt=str(action_res.get("expiresAt") or ""),
                                    display=(
                                        action_res.get("display")
                                        if isinstance(action_res.get("display"), dict)
                                        else {}
                                    ),
                                )
                                yield ActionHandoffEvent(data=payload)
                                telemetry.emit_safely(
                                    "handoff_create",
                                    status="created",
                                    trace_id=trace_id,
                                    correlation_id=correlation_id,
                                    fields={"outcome": "created"},
                                )
                                force_persistence = True

                elif kind == "on_tool_end":
                    tool_name = event.get("name")
                    tool_output = event.get("data", {}).get("output")
                    if isinstance(tool_name, str):
                        started_at = tool_started_at.pop(tool_name, time.perf_counter())
                        telemetry.emit_safely(
                            "tool_call",
                            status="completed",
                            latency_ms=(time.perf_counter() - started_at) * 1000,
                            trace_id=trace_id,
                            correlation_id=correlation_id,
                            fields={
                                "tool_name": safe_tool_name(tool_name),
                                "outcome": "completed",
                            },
                        )

                    output_data = None
                    if tool_output is not None:
                        if hasattr(tool_output, "content"):
                            if isinstance(tool_output.content, dict):
                                output_data = tool_output.content
                            else:
                                try:
                                    output_data = json.loads(str(tool_output.content))
                                except Exception:
                                    logger.debug("tool_output_content_not_json")
                            output_str = str(tool_output.content)
                        else:
                            if isinstance(tool_output, dict):
                                output_data = tool_output
                            else:
                                try:
                                    output_data = json.loads(str(tool_output))
                                except Exception:
                                    logger.debug("tool_output_not_json")
                            output_str = str(tool_output)
                        summary_str = output_str.split("\n")[0].strip()
                    else:
                        summary_str = ""

                    safe_readiness = None
                    if tool_name == "check_booking_readiness":
                        if output_data and "error" in output_data:
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
                                error_code="READINESS_RESPONSE_INVALID",
                                error_message="Booking readiness could not be verified safely.",
                            )
                            pipeline = None
                            req_id = None
                            released = True
                            if err_event:
                                yield err_event
                            return
                        else:
                            safe_readiness = validate_booking_readiness_response(output_data)
                            if safe_readiness is None:
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
                                    error_code="READINESS_RESPONSE_INVALID",
                                    error_message="Booking readiness could not be verified safely.",
                                )
                                pipeline = None
                                req_id = None
                                released = True
                                if err_event:
                                    yield err_event
                                return
                            summary_str = "Successfully checked booking readiness."

                    yield ToolResultEvent(
                        data=ToolResultPayload(name=tool_name or "", result=summary_str)
                    )

                    if tool_name == "search_flights":
                        raw_results = None
                        if redis_client is not None:
                            try:
                                owner = SnapshotOwner(
                                    user_id=command.user_id, chat_session_id=session_id
                                )
                                lifecycle = TrustedSearchSnapshotLifecycle(
                                    TrustedSnapshotRepository(redis_client)
                                )
                                latest_snapshot = await lifecycle.load_active(owner)
                                if latest_snapshot:
                                    raw_results = [
                                        res.model_dump(mode="json")
                                        for res in lifecycle.project_for_browser(latest_snapshot)
                                    ]
                            except Exception:
                                logger.warning("search_result_projection_failed")
                        if raw_results:
                            yield FlightResultsEvent(data=FlightResultsPayload(results=raw_results))

                    elif (
                        tool_name == "check_booking_readiness"
                        and safe_readiness
                        and safe_readiness["ready"] is False
                    ):
                        action = safe_readiness["nextAction"]
                        scope = safe_readiness["scope"]

                        safe_passengers = []
                        for p in safe_readiness["passengers"]:
                            safe_sections = []
                            for s in p["sections"]:
                                safe_fields = []
                                for f in s["fields"]:
                                    safe_fields.append(
                                        {
                                            "name": f["name"],
                                            "status": f["status"],
                                            "reason": f["reason"],
                                        }
                                    )
                                safe_sections.append({"name": s["name"], "fields": safe_fields})
                            safe_passengers.append(
                                {
                                    "passengerType": p["passengerType"],
                                    "passengerOrdinal": p["passengerOrdinal"],
                                    "sections": safe_sections,
                                }
                            )

                        target = "/checkout/passengers"
                        if action == "COMPLETE_PROFILE":
                            target = "/profile"

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
                                error_message="The requested action could not be emitted because the session lease was lost.",
                            )
                            pipeline = None
                            req_id = None
                            released = True
                            if err_event:
                                yield err_event
                            return

                        payload = ActionRequiredPayload(
                            action=action,
                            scope=scope,
                            passengers=safe_passengers,
                            target=target,
                        )
                        yield ActionRequiredEvent(data=payload)

                        # Release queue lease and close pipeline upon ActionRequired
                        if pipeline is not None:
                            try:
                                await asyncio.wait_for(pipeline.aclose(), timeout=1.0)
                            except Exception:
                                pass
                            pipeline = None
                        if queue_manager is not None and req_id is not None and not released:
                            released = True
                            try:
                                await asyncio.wait_for(
                                    queue_manager.release(session_id, req_id), timeout=2.0
                                )
                            except Exception:
                                pass
                            req_id = None
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
                        pass
                    pipeline = None
                if queue_manager is not None and req_id is not None and not released:
                    released = True
                    try:
                        await asyncio.wait_for(
                            queue_manager.release(session_id, req_id), timeout=2.0
                        )
                    except Exception:
                        pass
                    req_id = None

                yield DoneEvent(data=DonePayload(messageId=agent_message_id, sessionId=session_id))

                # Schedule non-blocking memory summarization
                memory_mgr = MemoryManager(
                    window_size=getattr(settings, "MEMORY_WINDOW_SIZE", 20),
                    token_budget=getattr(settings, "MEMORY_TOKEN_BUDGET", 4000),
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
                        pass
                    pipeline = None
                if queue_manager is not None and req_id is not None and not released:
                    released = True
                    try:
                        await asyncio.wait_for(
                            queue_manager.release(session_id, req_id), timeout=2.0
                        )
                    except Exception:
                        pass
                    req_id = None

        except OutputGuardrailBlockedError as e:
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
