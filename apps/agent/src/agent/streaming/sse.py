import json
import asyncio
import logging
from fastapi import APIRouter, Request, HTTPException, Header
from sse_starlette.sse import EventSourceResponse
from agent.config import get_settings
from agent.models.requests import ChatStreamRequest
from agent.tools.nestjs_client import NestJSClient
from agent.agents.chat_agent import get_chat_model, format_messages
from agent.graph.graph import graph
from agent.memory.manager import MemoryManager
from langchain_core.messages import HumanMessage
from agent.guardrails.output_pipeline import OutputGuardrailPipeline, OutputGuardrailBlockedError

logger = logging.getLogger("agent.streaming")
router = APIRouter()

@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    body: ChatStreamRequest,
    authorization: str = Header(None)
):
    """
    Handle POST /chat/stream requests, performing validation, checking guardrails,
    fetching memory context, and returning an SSE stream with LangGraph output.
    """
    settings = get_settings()

    # 1. Authorization validation first (security check)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1]
    
    client = NestJSClient(base_url=settings.NESTJS_API_URL, token=token)

    # 2. Message length check
    if body.message and len(body.message) > settings.MAX_MESSAGE_LENGTH:
        raise HTTPException(status_code=400, detail="Message exceeds maximum length")

    # 3. Guardrails check
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

    # 4. Session auto-creation if not provided
    session_id = body.sessionId
    if not session_id:
        try:
            session_data = await client.create_session(title=None)
            session_id = session_data["id"]
        except Exception as e:
            logger.error(f"Failed to create session on NestJS API: {e!s}")
            raise HTTPException(status_code=503, detail="NestJS API unavailable") from e

    # 4.5. Message Queue Locking
    queue_manager = getattr(request.app.state, "message_queue", None)
    if queue_manager:
        await queue_manager.acquire(session_id)

    released = False
    try:
        # 5. Fetch memory context from NestJS Client
        try:
            memory_data = await client.get_memory(session_id, recent_count=settings.MEMORY_WINDOW_SIZE)
            history = memory_data.get("recentMessages", [])
            summary = memory_data.get("summary", None)
        except Exception as e:
            logger.error(f"Failed to fetch memory from NestJS API: {e!s}")
            raise HTTPException(status_code=503, detail="NestJS API memory service unavailable") from e

        # 6. Generator-based SSE streaming with bounded queue (maxsize=100)
        q = asyncio.Queue(maxsize=100)
        from agent.main import active_streams
        active_streams.add(q)

        # Background producer task
        async def producer():
            output_config = settings.output_guardrail
            pipeline = OutputGuardrailPipeline(config=output_config, nemo_service=guardrails)
            partial_response = ""
            persisted = False
            config = {
                "configurable": {
                    "thread_id": session_id,
                    "nestjs_client": client
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
                        {"messages": messages, "iteration_count": 0, "pending_confirmation": None},
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
                        if tool_output:
                            if hasattr(tool_output, "content"):
                                output_str = str(tool_output.content)
                            else:
                                output_str = str(tool_output)
                            summary_str = output_str.split("\n")[0].strip()
                        else:
                            summary_str = ""
                        await q.put({
                            "event": "tool_result",
                            "data": json.dumps({
                                "name": tool_name,
                                "result": summary_str
                            })
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
                if current_state.next and "confirm" in current_state.next:
                    pending = current_state.values.get("pending_confirmation") or {}
                    await q.put({
                        "event": "confirmation_required",
                        "data": json.dumps(pending)
                    })
                else:
                    # Completed turn - Persist message batch and send done event
                    if partial_response.strip():
                        # Extract original user message content
                        user_msg_content = body.message
                        if not user_msg_content:
                            for msg in reversed(current_state.values.get("messages", [])):
                                if isinstance(msg, HumanMessage) or msg.__class__.__name__ == "HumanMessage" or getattr(msg, "type", "") == "human":
                                    user_msg_content = msg.content
                                    break
                        if not user_msg_content:
                            user_msg_content = "Action confirmed"

                        messages_payload = [
                            {"sender": "USER", "type": "STANDARD", "content": user_msg_content},
                            {"sender": "AGENT", "type": "STANDARD", "content": partial_response}
                        ]
                        try:
                            batch_res = await client.create_message_batch(session_id, messages_payload)
                            persisted = True
                        except Exception as persist_err:
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
                        asyncio.create_task(memory_mgr.check_and_summarize(session_id, client, total_count=original_total + 2))
                    else:
                        logger.warning(f"Empty or whitespace-only response generated for session {session_id}.")
            except OutputGuardrailBlockedError as e:
                logger.warning("Security alert: LLM output blocked by guardrail.")
                partial_message_id = None
                if not persisted and e.partial_response and e.partial_response.strip():
                    try:
                        user_msg_content = body.message
                        if not user_msg_content:
                            current_state = await graph.aget_state(config)
                            for msg in reversed(current_state.values.get("messages", [])):
                                if isinstance(msg, HumanMessage) or msg.__class__.__name__ == "HumanMessage" or getattr(msg, "type", "") == "human":
                                    user_msg_content = msg.content
                                    break
                        if not user_msg_content:
                            user_msg_content = "Action confirmed"

                        messages_payload = [
                            {"sender": "USER", "type": "STANDARD", "content": user_msg_content},
                            {"sender": "AGENT", "type": "STANDARD", "content": e.partial_response}
                        ]
                        batch_res = await client.create_message_batch(session_id, messages_payload)
                        persisted = True
                        for msg in batch_res.get("messages", []):
                            if msg.get("sender") == "AGENT":
                                partial_message_id = msg.get("id")
                    except Exception as persist_err:
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
                        user_msg_content = body.message
                        if not user_msg_content:
                            current_state = await graph.aget_state(config)
                            for msg in reversed(current_state.values.get("messages", [])):
                                if isinstance(msg, HumanMessage) or msg.__class__.__name__ == "HumanMessage" or getattr(msg, "type", "") == "human":
                                    user_msg_content = msg.content
                                    break
                        if not user_msg_content:
                            user_msg_content = "Action confirmed"

                        messages_payload = [
                            {"sender": "USER", "type": "STANDARD", "content": user_msg_content},
                            {"sender": "AGENT", "type": "STANDARD", "content": partial_response}
                        ]
                        await asyncio.shield(client.create_message_batch(session_id, messages_payload))
                        persisted = True
                    except Exception as e:
                        logger.error(f"Failed to persist partial response on connection drop: {e!s}")
                raise
            except Exception as e:
                logger.exception("LLM error during streaming")
                partial_message_id = None
                if not persisted and partial_response and partial_response.strip():
                    try:
                        user_msg_content = body.message
                        if not user_msg_content:
                            current_state = await graph.aget_state(config)
                            for msg in reversed(current_state.values.get("messages", [])):
                                if isinstance(msg, HumanMessage) or msg.__class__.__name__ == "HumanMessage" or getattr(msg, "type", "") == "human":
                                    user_msg_content = msg.content
                                    break
                        if not user_msg_content:
                            user_msg_content = "Action confirmed"

                        messages_payload = [
                            {"sender": "USER", "type": "STANDARD", "content": user_msg_content},
                            {"sender": "AGENT", "type": "STANDARD", "content": partial_response}
                        ]
                        batch_res = await client.create_message_batch(session_id, messages_payload)
                        persisted = True
                        for msg in batch_res.get("messages", []):
                            if msg.get("sender") == "AGENT":
                                partial_message_id = msg.get("id")
                    except Exception as persist_err:
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
                if queue_manager and not released:
                    released = True
                    await queue_manager.release(session_id)

        return EventSourceResponse(sse_generator())

    except Exception:
        if queue_manager and not released:
            released = True
            await queue_manager.release(session_id)
        raise
