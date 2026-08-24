import asyncio
import json
import logging
import time

from fastapi import APIRouter, Header, HTTPException, Request
from langchain_core.messages import HumanMessage
from sse_starlette.sse import EventSourceResponse

from agent.agents.chat_agent import format_messages
from agent.chat_turn import (
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
from agent.graph.graph import graph
from agent.guardrails.output_pipeline import OutputGuardrailBlockedError, OutputGuardrailPipeline
from agent.infrastructure.redis import get_redis_client
from agent.memory.manager import MemoryManager
from agent.models.requests import ChatStreamRequest
from agent.observability.chat_observability import ChatTelemetry, safe_opaque_id, safe_tool_name
from agent.sanitization.pii_scrubber import detect_pii
from agent.tools.nestjs_client import NestJSClient, validate_booking_readiness_response
from agent.trusted_search_snapshot import (
    SnapshotOwner,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

logger = logging.getLogger("agent.streaming")
guardrails_logger = logging.getLogger("agent.guardrails")
router = APIRouter()
chat_telemetry = ChatTelemetry(logger)

background_tasks: set[asyncio.Task] = set()


def _resolve_correlation_id(value: str | None) -> str:
    """Return an opaque telemetry identifier, never a request/session identifier."""
    return safe_opaque_id(value)


async def _resolve_user_message(body, graph, config) -> str:
    """
    Resolves the original user message from body or graph state.
    """
    if body.message:
        return body.message
    try:
        current_state = await graph.aget_state(config)
        for msg in reversed(current_state.values.get("messages", [])):
            if (
                isinstance(msg, HumanMessage)
                or msg.__class__.__name__ == "HumanMessage"
                or getattr(msg, "type", "") == "human"
            ):
                return msg.content
    except Exception:  # noqa: BLE001
        logger.warning("graph_user_message_unavailable")
    return "Action confirmed"


async def _persist_response(
    client,
    session_id: str,
    user_msg: str,
    response_text: str,
    user_already_persisted: bool = False,
    use_shield: bool = False,
    queue_manager=None,
):
    """
    Persists the user and agent messages as a batch.
    Revalidates active fence if queue_manager is provided before performing persistence.
    Returns the batch result dictionary.
    """
    if queue_manager:
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


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    body: ChatStreamRequest,
    authorization: str = Header(None),
    x_trace_id: str = Header(None, alias="X-Trace-Id"),
    x_correlation_id: str = Header(None, alias="X-Correlation-Id"),
):
    """
    Handle POST /chat/stream requests, performing validation, checking guardrails,
    fetching memory context, and returning an SSE stream with LangGraph output.
    """
    settings = get_settings()

    # 1. Authorization validation first (canonical JWT profile: sub, iss, aud, jti)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1]

    from agent.utils.auth import decode_and_verify_jwt

    try:
        issuer = getattr(settings, "JWT_ISSUER", "booking-systems-api")
        audience = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")
        secrets_to_try = (
            settings.jwt_secret_ring
            if hasattr(settings, "jwt_secret_ring")
            else settings.JWT_SECRET
        )
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

    client = NestJSClient(base_url=settings.NESTJS_API_URL, token=token)
    trace_id = _resolve_correlation_id(x_trace_id)
    client.trace_id = trace_id
    correlation_id = _resolve_correlation_id(x_correlation_id)
    client.correlation_id = correlation_id

    # 2. NestJS access check (active user & revocation check) BEFORE quota or session lock
    access_res = await client.check_user_access(sub=user_id, jti=jti)
    if not access_res.get("allowed"):
        raise HTTPException(status_code=401, detail="User account inactive or token revoked")

    # 3. Message length check
    if body.message and len(body.message) > settings.MAX_MESSAGE_LENGTH:
        raise HTTPException(status_code=400, detail="Message exceeds maximum length")

    # 4. Guardrails check (input safety & ingress PII detection)
    if body.message and detect_pii(body.message):
        guardrails_logger.warning("Ingress PII detected in user message: REDACTED")

        async def pii_error_generator():
            event = ErrorEvent(
                data=ErrorPayload(
                    code="GUARDRAIL_BLOCKED",
                    message="Your message contains protected personal information and cannot be processed.",
                    partialMessageId=None,
                )
            )
            yield {"event": event.event, "data": event.data.model_dump_json()}

        return EventSourceResponse(pii_error_generator())

    guardrails = getattr(request.app.state, "guardrails", None)
    if guardrails and body.message:
        is_allowed, reason = await guardrails.validate_message(body.message)
        if not is_allowed:
            if "unavailable" in reason.lower():
                raise HTTPException(status_code=503, detail="Safety check unavailable")

            async def error_generator():
                event = ErrorEvent(
                    data=ErrorPayload(
                        code="GUARDRAIL_BLOCKED",
                        message="Your message could not be processed.",
                        partialMessageId=None,
                    )
                )
                yield {"event": event.event, "data": event.data.model_dump_json()}

            return EventSourceResponse(error_generator())

    # 5. Rate Limit / Quota check (accepted-only charge) BEFORE session lock / model / persistence
    quota_started = time.perf_counter()
    try:
        redis_client = get_redis_client()
        if not redis_client:
            raise ValueError("Redis client not initialized")
    except Exception as e:
        raise HTTPException(status_code=503, detail="CHAT_CONTROL_PLANE_UNAVAILABLE") from e

    from agent.repositories.chat_budget_repository import (
        BudgetExceededException,
        ChatBudgetRepository,
        RedisUnavailableException,
    )

    budget_repo = ChatBudgetRepository(redis_client)
    try:
        burst_window_seconds = getattr(settings, "CHAT_BURST_WINDOW_SECONDS", 60)
        daily_limit = getattr(
            settings, "CHAT_DAILY_MESSAGE_LIMIT", getattr(settings, "CHAT_QUOTA_DAILY", 50)
        )
        burst_limit = getattr(
            settings, "CHAT_BURST_LIMIT", getattr(settings, "CHAT_QUOTA_BURST", 60)
        )
        burst_window_id = f"w_{int(time.time()) // burst_window_seconds}"
        await budget_repo.admit_request(
            user_id=user_id,
            burst_window_id=burst_window_id,
            daily_limit=daily_limit,
            burst_limit=burst_limit,
            burst_ttl=burst_window_seconds,
        )
        chat_telemetry.emit_safely(
            "quota_admission",
            status="accepted",
            latency_ms=(time.perf_counter() - quota_started) * 1000,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": "admitted", "dependency": "redis"},
        )
    except BudgetExceededException as e:
        reason = "daily_quota" if "daily" in str(e).lower() else "burst_limit"
        chat_telemetry.emit_safely(
            "quota_admission",
            status="rejected",
            latency_ms=(time.perf_counter() - quota_started) * 1000,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": "rejected", "error_class": reason},
        )
        if "daily" in str(e).lower():
            raise HTTPException(status_code=429, detail="CHAT_DAILY_QUOTA_EXCEEDED") from e
        raise HTTPException(status_code=429, detail="CHAT_BURST_LIMIT_EXCEEDED") from e
    except RedisUnavailableException as e:
        chat_telemetry.emit_safely(
            "quota_admission",
            status="failed",
            latency_ms=(time.perf_counter() - quota_started) * 1000,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": "unavailable", "error_class": "control_plane_unavailable"},
        )
        raise HTTPException(status_code=503, detail="CHAT_CONTROL_PLANE_UNAVAILABLE") from e

    # 6. Session auto-creation & queue locking
    session_id = body.sessionId
    if not session_id:
        try:
            session_data = await client.create_session(title=None)
            session_id = session_data["id"]
        except Exception as e:
            logger.error("nestjs_session_creation_failed")
            raise HTTPException(status_code=503, detail="NestJS API unavailable") from e

    queue_manager = getattr(request.app.state, "message_queue", None)
    req_id = None
    if queue_manager:
        req_id = await queue_manager.acquire(session_id, user_id=user_id)
        fence = queue_manager.get_fence(session_id)
        client.set_fencing_token(fence)

    released = False
    pipeline = None
    try:
        # Fetch memory context from NestJS Client
        try:
            memory_data = await client.get_memory(
                session_id, recent_count=settings.MEMORY_WINDOW_SIZE
            )
            history = memory_data.get("recentMessages", [])
            summary = memory_data.get("summary", None)
        except Exception as e:
            logger.error("nestjs_memory_fetch_failed")
            err_msg = str(e)
            if "NOT_FOUND" in err_msg or "owned" in err_msg.lower() or "404" in err_msg:
                raise HTTPException(status_code=404, detail="CHAT_SESSION_NOT_FOUND") from e
            raise HTTPException(
                status_code=503, detail="NestJS API memory service unavailable"
            ) from e

        # Read TrustedSearchSnapshot from Redis
        trusted_snapshot_dict = None
        snapshot_state = "miss"
        try:
            redis_client = get_redis_client()
            owner = SnapshotOwner(user_id=user_id, chat_session_id=session_id)
            repo = TrustedSnapshotRepository(redis_client)
            lifecycle = TrustedSearchSnapshotLifecycle(repo)
            snapshot_obj = await lifecycle.load_active(owner)
            if snapshot_obj:
                trusted_snapshot_dict = snapshot_obj.model_dump(mode="json")
                snapshot_state = "hit"
        except Exception:
            logger.debug("trusted_snapshot_lookup_failed")
            snapshot_state = "unavailable"
        chat_telemetry.emit_safely(
            "snapshot_read",
            status=snapshot_state,
            trace_id=trace_id,
            correlation_id=correlation_id,
            fields={"outcome": snapshot_state},
        )

        # 6. Generator-based SSE streaming with bounded queue (maxsize=100)
        q: asyncio.Queue[ChatTurnEvent | dict | None] = asyncio.Queue(maxsize=100)
        from agent.main import active_streams

        active_streams.add(q)

        # Background producer task
        async def producer():
            nonlocal pipeline
            output_config = settings.output_guardrail
            pipeline = OutputGuardrailPipeline(
                config=output_config, nemo_service=guardrails, session_id=session_id
            )
            partial_response = ""
            user_msg_persisted = False
            persisted = False
            force_persistence = False
            config = {
                "configurable": {
                    "thread_id": session_id,
                    "user_id": user_id,
                    "nestjs_client": client,
                    "trusted_snapshot": trusted_snapshot_dict,
                }
            }
            try:
                # Pre-persist user message immediately so that external APIs (like gateway) can access the current message context
                if body.message:
                    await client.create_message_batch(
                        session_id,
                        [{"sender": "USER", "type": "STANDARD", "content": body.message}],
                    )
                    user_msg_persisted = True
            except Exception:
                logger.warning("user_message_persistence_failed")
                await q.put(
                    ErrorEvent(
                        data=ErrorPayload(
                            code="PERSISTENCE_ERROR",
                            message="Failed to persist user message before tool execution.",
                            partialMessageId=None,
                        )
                    )
                )
                return

            try:
                # New message
                messages = format_messages(
                    history=history, current_message=body.message, summary=summary
                )
                event_stream = graph.astream_events(
                    {
                        "messages": messages,
                        "iteration_count": 0,
                        "pending_confirmation": None,
                        "handoff_required": False,
                        "trusted_snapshot": trusted_snapshot_dict,
                    },
                    config=config,
                    version="v2",
                )

                tool_started_at: dict[str, float] = {}
                async for event in event_stream:
                    kind = event.get("event")

                    if kind == "on_chat_model_stream":
                        chunk = event["data"].get("chunk")
                        if chunk and hasattr(chunk, "content") and chunk.content:
                            token_content = chunk.content
                            async for safe_chunk in pipeline.process_token(token_content):
                                partial_response += safe_chunk
                                await q.put(TokenEvent(data=TokenPayload(content=safe_chunk)))

                    elif kind == "on_tool_start":
                        tool_name = event.get("name")
                        tool_input = event["data"].get("input")
                        if isinstance(tool_name, str):
                            tool_started_at[tool_name] = time.perf_counter()

                        # We no longer handle signal_checkout_intent here.
                        # It is handled by the validate_handoff and create_handoff_token deterministic nodes.

                        # Never stream raw readiness tool input
                        if tool_name == "check_booking_readiness":
                            safe_input = {"message": "Checking booking readiness..."}
                            await q.put(
                                ToolCallEvent(
                                    data=ToolCallPayload(name=tool_name, inputs=safe_input)
                                )
                            )
                        else:
                            await q.put(
                                ToolCallEvent(
                                    data=ToolCallPayload(
                                        name=tool_name or "",
                                        inputs=tool_input if isinstance(tool_input, dict) else {},
                                    )
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
                            action_res = (
                                output.get("action", {}) if isinstance(output, dict) else {}
                            )
                            if isinstance(action_res, dict) and "error" in action_res:
                                chat_telemetry.emit_safely(
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
                                    action_res.get("error")
                                    or "Checkout handoff could not be created."
                                )
                                await q.put(
                                    ErrorEvent(
                                        data=ErrorPayload(
                                            code="HANDOFF_FAILED",
                                            message=err_msg,
                                            error=err_msg,
                                            partialMessageId=None,
                                        )
                                    )
                                )
                                return

                            if isinstance(action_res, dict):
                                handoff_token = action_res.get("handoffToken") or action_res.get(
                                    "token"
                                )
                                action_type = action_res.get("action")
                                if handoff_token and action_type == "begin_checkout":
                                    if (
                                        queue_manager
                                        and not await queue_manager.validate_active_fence(
                                            session_id
                                        )
                                    ):
                                        logger.warning("stale_fence_handoff_emission_aborted")
                                        await q.put(
                                            ErrorEvent(
                                                data=ErrorPayload(
                                                    code="PERSISTENCE_ERROR",
                                                    message="The requested action could not be emitted because the session lease was lost.",
                                                    partialMessageId=None,
                                                )
                                            )
                                        )
                                        return

                                    payload = ActionHandoffPayload(
                                        version=1,
                                        action="begin_checkout",
                                        handoffToken=handoff_token,
                                        expiresAt=str(action_res.get("expiresAt") or ""),
                                        display=action_res.get("display")
                                        if isinstance(action_res.get("display"), dict)
                                        else {},
                                    )

                                    await q.put(ActionHandoffEvent(data=payload))
                                    chat_telemetry.emit_safely(
                                        "handoff_create",
                                        status="created",
                                        trace_id=trace_id,
                                        correlation_id=correlation_id,
                                        fields={"outcome": "created"},
                                    )
                                    force_persistence = True

                    elif kind == "on_tool_end":
                        tool_name = event.get("name")
                        tool_output = event["data"].get("output")
                        if isinstance(tool_name, str):
                            started_at = tool_started_at.pop(tool_name, time.perf_counter())
                            chat_telemetry.emit_safely(
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
                        if tool_output:
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
                        # Do not emit arbitrary tool output in tool_result for check_booking_readiness
                        if tool_name == "check_booking_readiness":
                            if output_data and "error" in output_data:
                                await q.put(
                                    ErrorEvent(
                                        data=ErrorPayload(
                                            code="READINESS_RESPONSE_INVALID",
                                            message="Booking readiness could not be verified safely.",
                                            partialMessageId=None,
                                        )
                                    )
                                )
                                return
                            else:
                                safe_readiness = validate_booking_readiness_response(output_data)
                                if safe_readiness is None:
                                    await q.put(
                                        ErrorEvent(
                                            data=ErrorPayload(
                                                code="READINESS_RESPONSE_INVALID",
                                                message="Booking readiness could not be verified safely.",
                                                partialMessageId=None,
                                            )
                                        )
                                    )
                                    return
                                summary_str = "Successfully checked booking readiness."

                        await q.put(
                            ToolResultEvent(
                                data=ToolResultPayload(name=tool_name or "", result=summary_str)
                            )
                        )

                        if tool_name == "search_flights":
                            raw_results = None
                            try:
                                owner = SnapshotOwner(user_id=user_id, chat_session_id=session_id)
                                lifecycle = TrustedSearchSnapshotLifecycle(
                                    TrustedSnapshotRepository(get_redis_client())
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
                                await q.put(
                                    FlightResultsEvent(
                                        data=FlightResultsPayload(results=raw_results)
                                    )
                                )
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
                                await q.put(
                                    ErrorEvent(
                                        data=ErrorPayload(
                                            code="PERSISTENCE_ERROR",
                                            message="The requested action could not be emitted because the session lease was lost.",
                                            partialMessageId=None,
                                        )
                                    )
                                )
                                return

                            payload = ActionRequiredPayload(
                                action=action,
                                scope=scope,
                                passengers=safe_passengers,
                                target=target,
                            )

                            await q.put(ActionRequiredEvent(data=payload))
                            return

                # Flush the pipeline and yield any remaining safe chunks
                async for safe_chunk in pipeline.flush():
                    partial_response += safe_chunk
                    await q.put(TokenEvent(data=TokenPayload(content=safe_chunk)))

                # Completed turn - Persist message batch and send done event
                if partial_response.strip() or force_persistence:
                    if queue_manager and not await queue_manager.validate_active_fence(session_id):
                        logger.warning("stale_fence_completed_persistence_aborted")
                        await q.put(
                            ErrorEvent(
                                data=ErrorPayload(
                                    code="PERSISTENCE_ERROR",
                                    message="The response was generated but could not be saved.",
                                    partialMessageId=None,
                                )
                            )
                        )
                        return
                    user_msg_content = await _resolve_user_message(body, graph, config)
                    try:
                        batch_res = await _persist_response(
                            client,
                            session_id,
                            user_msg_content,
                            partial_response,
                            user_already_persisted=user_msg_persisted,
                            queue_manager=queue_manager,
                        )
                        persisted = True
                    except Exception:  # noqa: BLE001
                        logger.error("completed_response_persistence_failed")
                        await q.put(
                            ErrorEvent(
                                data=ErrorPayload(
                                    code="PERSISTENCE_ERROR",
                                    message="The response was generated but could not be saved.",
                                    partialMessageId=None,
                                )
                            )
                        )
                        return

                    agent_message_id = None
                    for msg in batch_res.get("messages", []):
                        if msg.get("sender") == "AGENT":
                            agent_message_id = msg.get("id")

                    await q.put(
                        DoneEvent(
                            data=DonePayload(messageId=agent_message_id, sessionId=session_id)
                        )
                    )

                    # Trigger token budget check and summarization
                    memory_mgr = MemoryManager(
                        window_size=settings.MEMORY_WINDOW_SIZE,
                        token_budget=settings.MEMORY_TOKEN_BUDGET,
                    )
                    original_total = memory_data.get("totalMessageCount", 0)
                    try:
                        await memory_mgr.check_and_summarize(
                            session_id, client, total_count=original_total + 2
                        )
                    except Exception:  # noqa: BLE001
                        logger.error("memory_summarization_failed")
                else:
                    logger.warning("empty_response_generated")
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
                partial_message_id = None
                if not persisted and e.partial_response and e.partial_response.strip():
                    try:
                        user_msg_content = await _resolve_user_message(body, graph, config)
                        batch_res = await _persist_response(
                            client,
                            session_id,
                            user_msg_content,
                            e.partial_response,
                            user_already_persisted=user_msg_persisted,
                            queue_manager=queue_manager,
                        )
                        persisted = True
                        for msg in batch_res.get("messages", []):
                            if msg.get("sender") == "AGENT":
                                partial_message_id = msg.get("id")
                    except Exception:  # noqa: BLE001
                        logger.error("guardrail_partial_persistence_failed")

                await q.put(
                    ErrorEvent(
                        data=ErrorPayload(
                            code="OUTPUT_GUARDRAIL_BLOCKED",
                            message="Response was blocked for safety reasons.",
                            partialMessageId=partial_message_id,
                        )
                    )
                )
            except asyncio.CancelledError:
                logger.warning("stream_connection_dropped")
                if not persisted and partial_response and partial_response.strip():
                    try:
                        user_msg_content = await _resolve_user_message(body, graph, config)
                        await _persist_response(
                            client,
                            session_id,
                            user_msg_content,
                            partial_response,
                            user_already_persisted=user_msg_persisted,
                            use_shield=True,
                            queue_manager=queue_manager,
                        )
                        persisted = True
                    except Exception:  # noqa: BLE001
                        logger.error("disconnect_partial_persistence_failed")
                        try:
                            q.put_nowait(
                                ErrorEvent(
                                    data=ErrorPayload(
                                        code="PERSISTENCE_ERROR",
                                        message="The response was generated but could not be saved.",
                                        partialMessageId=None,
                                    )
                                )
                            )
                        except asyncio.QueueFull:
                            logger.debug("disconnect_error_event_queue_full")
                raise
            except Exception:  # noqa: BLE001
                logger.error("llm_streaming_failed")
                partial_message_id = None
                if not persisted and partial_response and partial_response.strip():
                    try:
                        user_msg_content = await _resolve_user_message(body, graph, config)
                        batch_res = await _persist_response(
                            client,
                            session_id,
                            user_msg_content,
                            partial_response,
                            user_already_persisted=user_msg_persisted,
                            queue_manager=queue_manager,
                        )
                        persisted = True
                        for msg in batch_res.get("messages", []):
                            if msg.get("sender") == "AGENT":
                                partial_message_id = msg.get("id")
                    except Exception:  # noqa: BLE001
                        logger.error("llm_partial_persistence_failed")

                await q.put(
                    ErrorEvent(
                        data=ErrorPayload(
                            code="LLM_ERROR",
                            message="The AI model encountered an error. Please try again.",
                            partialMessageId=partial_message_id,
                        )
                    )
                )
            finally:
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    logger.debug("stream_sentinel_queue_full")

        producer_task = asyncio.create_task(producer())
        background_tasks.add(producer_task)
        producer_task.add_done_callback(background_tasks.discard)

        if queue_manager and req_id:
            attached = await queue_manager.attach_task(session_id, req_id, producer_task)
            if not attached:
                logger.warning("active_fence_lost_cancelling_stream")
                producer_task.cancel()

        async def sse_generator():
            nonlocal released
            try:
                while True:
                    event = await q.get()
                    if event is None:
                        break
                    if hasattr(event, "event") and hasattr(event, "data"):
                        event_name = event.event
                        data_val = (
                            event.data.model_dump_json()
                            if hasattr(event.data, "model_dump_json")
                            else json.dumps(event.data)
                        )
                        yield {"event": event_name, "data": data_val}
                        if event_name == "error":
                            break
                    elif isinstance(event, dict):
                        yield event
                        if event.get("event") == "error":
                            break
            finally:
                active_streams.discard(q)
                if not producer_task.done():
                    producer_task.cancel()
                if pipeline:
                    await pipeline.aclose()
                if queue_manager and req_id and not released:
                    released = True
                    await queue_manager.release(session_id, req_id)

        return EventSourceResponse(sse_generator())

    except BaseException:
        if queue_manager and req_id and not released:
            released = True
            await queue_manager.release(session_id, req_id)
        raise
