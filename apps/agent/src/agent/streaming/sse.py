import json
import asyncio
import logging
from fastapi import APIRouter, Request, HTTPException, Header
from sse_starlette.sse import EventSourceResponse
from agent.config import get_settings
from agent.models.requests import ChatStreamRequest
from agent.tools.nestjs_client import NestJSClient, validate_booking_readiness_response
from agent.agents.chat_agent import get_chat_model, format_messages
from agent.graph.graph import graph
from agent.memory.manager import MemoryManager
from langchain_core.messages import HumanMessage
from agent.guardrails.output_pipeline import OutputGuardrailPipeline, OutputGuardrailBlockedError

import jwt
from agent.repositories.trusted_snapshot_repository import TrustedSnapshotRepository
from agent.infrastructure.redis import get_redis_client
from agent.sanitization.pii_scrubber import detect_pii

logger = logging.getLogger("agent.streaming")
guardrails_logger = logging.getLogger("agent.guardrails")
router = APIRouter()

background_tasks: set[asyncio.Task] = set()

async def _resolve_user_message(body, graph, config) -> str:
    """
    Resolves the original user message from body or graph state.
    """
    if body.message:
        return body.message
    try:
        current_state = await graph.aget_state(config)
        for msg in reversed(current_state.values.get("messages", [])):
            if (isinstance(msg, HumanMessage) or
                msg.__class__.__name__ == "HumanMessage" or
                getattr(msg, "type", "") == "human"):
                return msg.content
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Failed to retrieve user message from graph state: {e!s}")
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
            logger.warning(f"Stale fence detected for session {session_id}. Aborting persistence.")
            raise RuntimeError("Session fence is no longer active")

    if user_already_persisted:
        payload = [
            {"sender": "AGENT", "type": "STANDARD", "content": response_text}
        ]
    else:
        payload = [
            {"sender": "USER", "type": "STANDARD", "content": user_msg},
            {"sender": "AGENT", "type": "STANDARD", "content": response_text}
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
    x_correlation_id: str = Header(None, alias="X-Correlation-Id")
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

    try:
        issuer = getattr(settings, "JWT_ISSUER", "booking-systems-api")
        audience = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=["HS256"],
            issuer=issuer,
            audience=audience,
            options={"verify_iss": True, "verify_aud": True},
        )
        user_id = str(payload.get("sub") or payload.get("id") or "")
        jti = payload.get("jti")
        if not user_id or not jti:
            raise HTTPException(status_code=401, detail="Invalid token: missing sub or jti claim")
    except Exception as err:
        raise HTTPException(status_code=401, detail="Invalid token") from err

    client = NestJSClient(base_url=settings.NESTJS_API_URL, token=token)
    if x_trace_id:
        client.trace_id = x_trace_id

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
            yield {
                "event": "error",
                "data": json.dumps({
                    "code": "GUARDRAIL_BLOCKED",
                    "message": "Your message contains protected personal information and cannot be processed.",
                    "partialMessageId": None
                })
            }
        return EventSourceResponse(pii_error_generator())

    guardrails = getattr(request.app.state, "guardrails", None)
    if guardrails and body.message:
        is_allowed, reason = await guardrails.validate_message(body.message)
        if not is_allowed:
            if "unavailable" in reason.lower():
                raise HTTPException(status_code=503, detail="Safety check unavailable")

            async def error_generator():
                yield {
                    "event": "error",
                    "data": json.dumps({
                        "code": "GUARDRAIL_BLOCKED",
                        "message": "Your message could not be processed.",
                        "partialMessageId": None
                    })
                }
            return EventSourceResponse(error_generator())

    # 5. Rate Limit / Quota check (accepted-only charge) BEFORE session lock / model / persistence
    try:
        redis_client = get_redis_client()
        if not redis_client:
            raise ValueError("Redis client not initialized")
    except Exception as e:
        raise HTTPException(status_code=503, detail="CHAT_CONTROL_PLANE_UNAVAILABLE") from e

    from agent.repositories.chat_budget_repository import ChatBudgetRepository, BudgetExceededException, RedisUnavailableException
    budget_repo = ChatBudgetRepository(redis_client)
    try:
        import time
        burst_window_seconds = getattr(settings, "CHAT_BURST_WINDOW_SECONDS", 60)
        daily_limit = getattr(settings, "CHAT_DAILY_MESSAGE_LIMIT", getattr(settings, "CHAT_QUOTA_DAILY", 50))
        burst_limit = getattr(settings, "CHAT_BURST_LIMIT", getattr(settings, "CHAT_QUOTA_BURST", 60))
        burst_window_id = f"w_{int(time.time()) // burst_window_seconds}"
        await budget_repo.admit_request(
            user_id=user_id,
            burst_window_id=burst_window_id,
            daily_limit=daily_limit,
            burst_limit=burst_limit,
            burst_ttl=burst_window_seconds,
        )
    except BudgetExceededException as e:
        if "daily" in str(e).lower():
            raise HTTPException(status_code=429, detail="CHAT_DAILY_QUOTA_EXCEEDED") from e
        raise HTTPException(status_code=429, detail="CHAT_BURST_LIMIT_EXCEEDED") from e
    except RedisUnavailableException as e:
        raise HTTPException(status_code=503, detail="CHAT_CONTROL_PLANE_UNAVAILABLE") from e

    # 6. Session auto-creation & queue locking
    session_id = body.sessionId
    if not session_id:
        try:
            session_data = await client.create_session(title=None)
            session_id = session_data["id"]
        except Exception as e:
            logger.error(f"Failed to create session on NestJS API: {e!s}")
            raise HTTPException(status_code=503, detail="NestJS API unavailable") from e

    client.correlation_id = x_correlation_id or session_id


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
            memory_data = await client.get_memory(session_id, recent_count=settings.MEMORY_WINDOW_SIZE)
            history = memory_data.get("recentMessages", [])
            summary = memory_data.get("summary", None)
        except Exception as e:
            logger.error(f"Failed to fetch memory from NestJS API: {e!s}")
            err_msg = str(e)
            if "NOT_FOUND" in err_msg or "owned" in err_msg.lower() or "404" in err_msg:
                raise HTTPException(status_code=404, detail="CHAT_SESSION_NOT_FOUND") from e
            raise HTTPException(status_code=503, detail="NestJS API memory service unavailable") from e

        # Read TrustedSearchSnapshot from Redis
        trusted_snapshot_dict = None
        try:
            redis_client = get_redis_client()
            snapshot_repo = TrustedSnapshotRepository(redis_client)
            snapshot_obj = await snapshot_repo.get_snapshot(user_id, session_id)
            if snapshot_obj:
                trusted_snapshot_dict = snapshot_obj.model_dump(mode="json")
        except Exception as e:
            logger.debug(f"Failed to read trusted snapshot from Redis: {e!s}")

        user_msg_persisted = False

        # 6. Generator-based SSE streaming with bounded queue (maxsize=100)
        q = asyncio.Queue(maxsize=100)
        from agent.main import active_streams
        active_streams.add(q)

        # Background producer task
        async def producer():
            nonlocal pipeline
            output_config = settings.output_guardrail
            pipeline = OutputGuardrailPipeline(config=output_config, nemo_service=guardrails, session_id=session_id)
            partial_response = ""
            persisted = False
            config = {
                "configurable": {
                    "thread_id": session_id,
                    "nestjs_client": client,
                    "trusted_snapshot": trusted_snapshot_dict
                }
            }
            try:
                # Check if resume operation
                if body.confirmed is not None:
                    current_state = await graph.aget_state(config)
                    pending = current_state.values.get("pending_confirmation")
                    if not pending:
                        pending = {}
                    pending["confirmed"] = body.confirmed

                    await graph.aupdate_state(config, {"pending_confirmation": pending}, as_node="agent")
                    event_stream = graph.astream_events(None, config=config, version="v2")
                else:
                    # New message
                    messages = format_messages(
                        history=history,
                        current_message=body.message,
                        summary=summary
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
                        version="v2"
                    )

                async for event in event_stream:
                    kind = event.get("event")

                    if kind == "on_chat_model_stream":
                        chunk = event["data"].get("chunk")
                        if chunk and hasattr(chunk, "content") and chunk.content:
                            token_content = chunk.content
                            async for safe_chunk in pipeline.process_token(token_content):
                                partial_response += safe_chunk
                                await q.put({
                                    "event": "token",
                                    "data": json.dumps({"content": safe_chunk})
                                })

                    elif kind == "on_tool_start":
                        tool_name = event.get("name")
                        tool_input = event["data"].get("input")

                        # Never stream raw readiness tool input
                        if tool_name == "check_booking_readiness":
                            safe_input = {"message": "Checking booking readiness..."}
                            await q.put({
                                "event": "tool_call",
                                "data": json.dumps({
                                    "name": tool_name,
                                    "inputs": safe_input
                                })
                            })
                        else:
                            await q.put({
                                "event": "tool_call",
                                "data": json.dumps({
                                    "name": tool_name,
                                    "inputs": tool_input
                                })
                            })


                    elif kind == "on_tool_end":
                        tool_name = event.get("name")
                        tool_output = event["data"].get("output")

                        output_data = None
                        if tool_output:
                            if hasattr(tool_output, "content"):
                                if isinstance(tool_output.content, dict):
                                    output_data = tool_output.content
                                else:
                                    try:
                                        output_data = json.loads(str(tool_output.content))
                                    except Exception:
                                        pass
                                output_str = str(tool_output.content)
                            else:
                                if isinstance(tool_output, dict):
                                    output_data = tool_output
                                else:
                                    try:
                                        output_data = json.loads(str(tool_output))
                                    except Exception:
                                        pass
                                output_str = str(tool_output)
                            summary_str = output_str.split("\n")[0].strip()
                        else:
                            summary_str = ""

                        safe_readiness = None
                        # Do not emit arbitrary tool output in tool_result for check_booking_readiness
                        if tool_name == "check_booking_readiness":
                            if output_data and "error" in output_data:
                                await q.put({
                                    "event": "error",
                                    "data": json.dumps({
                                        "code": "READINESS_RESPONSE_INVALID",
                                        "message": "Booking readiness could not be verified safely.",
                                        "partialMessageId": None,
                                    }),
                                })
                                return
                            else:
                                safe_readiness = validate_booking_readiness_response(output_data)
                                if safe_readiness is None:
                                    await q.put({
                                        "event": "error",
                                        "data": json.dumps({
                                            "code": "READINESS_RESPONSE_INVALID",
                                            "message": "Booking readiness could not be verified safely.",
                                            "partialMessageId": None,
                                        }),
                                    })
                                    return
                                summary_str = "Successfully checked booking readiness."

                        await q.put({
                            "event": "tool_result",
                            "data": json.dumps({
                                "name": tool_name,
                                "result": summary_str
                            })
                        })

                        if tool_name == "search_flights":
                            from agent.tools.search_flights import FLIGHTS_CACHE
                            raw_cache = FLIGHTS_CACHE.pop(session_id, None)
                            raw_results = raw_cache.get("results") if raw_cache else None
                            if raw_results:
                                await q.put({
                                    "event": "flight_results",
                                    "data": json.dumps({
                                        "results": raw_results
                                    })
                                })
                        elif tool_name == "check_booking_readiness" and safe_readiness and safe_readiness["ready"] is False:
                            action = safe_readiness["nextAction"]
                            scope = safe_readiness["scope"]

                            safe_passengers = []
                            for p in safe_readiness["passengers"]:
                                safe_sections = []
                                for s in p["sections"]:
                                    safe_fields = []
                                    for f in s["fields"]:
                                        safe_fields.append({
                                            "name": f["name"],
                                            "status": f["status"],
                                            "reason": f["reason"],
                                        })
                                    safe_sections.append({
                                        "name": s["name"],
                                        "fields": safe_fields
                                    })
                                safe_passengers.append({
                                    "passengerType": p["passengerType"],
                                    "passengerOrdinal": p["passengerOrdinal"],
                                    "sections": safe_sections
                                })

                            target = "/checkout/passengers"
                            if action == "COMPLETE_PROFILE":
                                target = "/profile"

                            if queue_manager and not await queue_manager.validate_active_fence(session_id):
                                logger.warning(f"Stale fence prior to ACTION_REQUIRED emission for session {session_id}. Aborting.")
                                return

                            payload = {
                                "action": action,
                                "scope": scope,
                                "passengers": safe_passengers,
                                "target": target
                            }

                            await q.put({
                                "event": "ACTION_REQUIRED",
                                "data": json.dumps(payload)
                            })


                # Flush the pipeline and yield any remaining safe chunks
                async for safe_chunk in pipeline.flush():
                    partial_response += safe_chunk
                    await q.put({
                        "event": "token",
                        "data": json.dumps({"content": safe_chunk})
                    })

                # Check if the graph is suspended
                current_state = await graph.aget_state(config)
                if current_state.values.get("handoff_required"):
                    return
                if current_state.next and "confirm" in current_state.next:
                    pending = current_state.values.get("pending_confirmation") or {}
                    await q.put({
                        "event": "confirmation_required",
                        "data": json.dumps(pending)
                    })
                else:
                    # Completed turn - Persist message batch and send done event
                    if partial_response.strip():
                        if queue_manager and not await queue_manager.validate_active_fence(session_id):
                            logger.warning(f"Stale fence prior to completed turn persistence for session {session_id}. Aborting.")
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
                        except Exception as persist_err:  # noqa: BLE001
                            logger.error(f"Failed to persist completed response: {persist_err!s}")
                            await q.put({
                                "event": "error",
                                "data": json.dumps({
                                    "code": "PERSISTENCE_ERROR",
                                    "message": "The response was generated but could not be saved.",
                                    "partialMessageId": None
                                })
                            })
                            return

                        agent_message_id = None
                        for msg in batch_res.get("messages", []):
                            if msg.get("sender") == "AGENT":
                                agent_message_id = msg.get("id")

                        await q.put({
                            "event": "done",
                            "data": json.dumps({
                                "messageId": agent_message_id,
                                "sessionId": session_id
                            })
                        })

                        # Trigger token budget check and summarization
                        memory_mgr = MemoryManager(
                            window_size=settings.MEMORY_WINDOW_SIZE,
                            token_budget=settings.MEMORY_TOKEN_BUDGET
                        )
                        original_total = memory_data.get("totalMessageCount", 0)
                        try:
                            await memory_mgr.check_and_summarize(session_id, client, total_count=original_total + 2)
                        except Exception as mem_err:  # noqa: BLE001
                            logger.error(f"Failed during memory summarization for session {session_id}: {mem_err!s}")
                    else:
                        logger.warning(f"Empty or whitespace-only response generated for session {session_id}.")
            except OutputGuardrailBlockedError as e:
                guardrails_logger.warning(json.dumps({
                    "event": "security_block",
                    "session_id": session_id,
                    "guardrail_layer": e.layer,
                    "rule_name": e.rule,
                    "message": "LLM output blocked by guardrail"
                }))
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
                    except Exception as persist_err:  # noqa: BLE001
                        logger.error(f"Failed to persist partial response on guardrail block: {persist_err!s}")

                await q.put({
                    "event": "error",
                    "data": json.dumps({
                        "code": "OUTPUT_GUARDRAIL_BLOCKED",
                        "message": "Response was blocked for safety reasons.",
                        "partialMessageId": partial_message_id
                    })
                })
            except asyncio.CancelledError:
                logger.warning(f"Connection dropped mid-stream for session {session_id}.")
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
                    except Exception as e:  # noqa: BLE001
                        logger.error(f"Failed to persist partial response on connection drop: {e!s}")
                raise
            except Exception as e:  # noqa: BLE001
                logger.exception("LLM error during streaming")
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
                    except Exception as persist_err:  # noqa: BLE001
                        logger.error(f"Failed to persist partial response on LLM error: {persist_err!s}")

                await q.put({
                    "event": "error",
                    "data": json.dumps({
                        "code": "LLM_ERROR",
                        "message": "The AI model encountered an error. Please try again.",
                        "partialMessageId": partial_message_id
                    })
                })
            finally:
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    pass

        producer_task = asyncio.create_task(producer())
        background_tasks.add(producer_task)
        producer_task.add_done_callback(background_tasks.discard)

        if queue_manager and req_id:
            attached = await queue_manager.attach_task(session_id, req_id, producer_task)
            if not attached:
                logger.warning(f"Lock active fence for session {session_id} is no longer active. Cancelling producer task.")
                producer_task.cancel()

        async def sse_generator():
            nonlocal released
            try:
                while True:
                    event = await q.get()
                    if event is None:
                        break
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
