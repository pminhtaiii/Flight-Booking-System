import json
import asyncio
import logging
from fastapi import APIRouter, Request, HTTPException, Header
from sse_starlette.sse import EventSourceResponse
from agent.config import get_settings
from agent.models.requests import ChatStreamRequest
from agent.tools.nestjs_client import NestJSClient
from agent.agents.chat_agent import get_chat_model, format_messages

logger = logging.getLogger("agent.streaming")
router = APIRouter()

@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    body: ChatStreamRequest,
    authorization: str = Header(None)
):
    settings = get_settings()

    # 1. Authorization validation first (security check)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    token = authorization.split(" ", 1)[1]
    
    client = NestJSClient(base_url=settings.NESTJS_API_URL, token=token)

    # 2. Message length check
    if len(body.message) > settings.MAX_MESSAGE_LENGTH:
        raise HTTPException(status_code=400, detail="Message exceeds maximum length")

    # 3. Guardrails check
    guardrails = getattr(request.app.state, "guardrails", None)
    if guardrails:
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
        partial_response = ""
        try:
            # Format messages for LangChain agent
            messages = format_messages(
                history=history,
                current_message=body.message,
                summary=summary
            )
            
            # Streaming LLM tokens
            model = get_chat_model()
            async for chunk in model.astream(messages):
                token_content = chunk.content
                if token_content:
                    partial_response += token_content
                    await q.put({
                        "event": "token",
                        "data": json.dumps({"content": token_content})
                    })
            
            # Done event - Persist message batch and send done event
            messages_payload = [
                {"sender": "USER", "type": "STANDARD", "content": body.message},
                {"sender": "AGENT", "type": "STANDARD", "content": partial_response}
            ]
            batch_res = await client.create_message_batch(session_id, messages_payload)
            
            # Extract agent message id
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
        except Exception as e:
            logger.error(f"Error during streaming: {e!s}")
            await q.put({
                "event": "error",
                "data": json.dumps({
                    "code": "LLM_ERROR",
                    "message": "The AI model encountered an error. Please try again.",
                    "partialMessageId": None
                })
            })
        finally:
            await q.put(None)

    producer_task = asyncio.create_task(producer())

    async def sse_generator():
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

    return EventSourceResponse(sse_generator())
