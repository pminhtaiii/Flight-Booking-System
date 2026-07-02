import pytest
import asyncio
import httpx
import json
import time
import jwt
from unittest.mock import AsyncMock, patch, MagicMock
from langchain_core.messages import AIMessage, HumanMessage, AIMessageChunk, BaseMessage
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatResult, ChatGeneration, ChatGenerationChunk
from pydantic import Field
from typing import List, Optional, Any, AsyncIterator

from agent.main import app
from agent.tools.nestjs_client import NestJSClient

class MockStreamingLLM(BaseChatModel):
    responses: List[Any] = Field(default_factory=list)

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any
    ) -> ChatResult:
        resp = self.responses.pop(0) if self.responses else AIMessage(content="Hello")
        return ChatResult(generations=[ChatGeneration(message=resp)])

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any
    ) -> AsyncIterator[ChatGenerationChunk]:
        resp = self.responses.pop(0) if self.responses else AIMessage(content="Hello")
        if resp.tool_calls:
            yield ChatGenerationChunk(message=AIMessageChunk(
                content=resp.content,
                tool_calls=resp.tool_calls,
                id=resp.id
            ))
        else:
            content = resp.content
            if content:
                words = content.split(" ")
                for i, word in enumerate(words):
                    space = " " if i < len(words) - 1 else ""
                    yield ChatGenerationChunk(message=AIMessageChunk(content=word + space))
            else:
                yield ChatGenerationChunk(message=AIMessageChunk(content=""))

    @property
    def _llm_type(self) -> str:
        return "mock-streaming-llm"


def parse_sse(lines):
    events = []
    current_event = {}
    for line in lines:
        if isinstance(line, bytes):
            line = line.decode("utf-8")
        line = line.strip()
        if not line:
            if current_event:
                events.append(current_event)
                current_event = {}
            continue
        if ":" in line:
            key, val = line.split(":", 1)
            key = key.strip()
            val = val.strip()
            if key == "event":
                current_event["event"] = val
            elif key == "data":
                try:
                    current_event["data"] = json.loads(val)
                except Exception:
                    current_event["data"] = val
    if current_event:
        events.append(current_event)
    return events


JWT_SECRET = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"

def get_auth_headers():
    payload = {
        "sub": "12345",
        "email": "test@example.com",
        "exp": int(time.time()) + 100
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def mock_nestjs_client():
    client = MagicMock(spec=NestJSClient)
    client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    client.create_message_batch = AsyncMock(return_value={
        "messages": [
            {"id": "msg-user-123", "sender": "USER"},
            {"id": "msg-agent-456", "sender": "AGENT"}
        ]
    })
    client.get_gateway_flights_search = AsyncMock()
    return client


@pytest.fixture(autouse=True)
def mock_guardrails(monkeypatch):
    mock_gr = MagicMock()
    mock_gr.is_healthy.return_value = True
    mock_gr.validate_message = AsyncMock(return_value=(True, ""))
    monkeypatch.setattr(app.state, "guardrails", mock_gr, raising=False)
    return mock_gr


@pytest.mark.asyncio
async def test_sse_simple_chat(mock_nestjs_client):
    headers = get_auth_headers()
    llm = MockStreamingLLM(responses=[AIMessage(content="Hello there! How can I help you today?")])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "hello", "sessionId": "session-simple"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(token_events) > 0
            assert "".join([e["data"]["content"] for e in token_events]) == "Hello there! How can I help you today?"
            assert len(done_events) == 1
            assert done_events[0]["data"]["sessionId"] == "session-simple"


@pytest.mark.asyncio
async def test_sse_readonly_tool(mock_nestjs_client):
    headers = get_auth_headers()
    
    mock_nestjs_client.get_gateway_flights_search.return_value = {
        "results": [{"flightNumber": "VN310", "price": 452.0}]
    }
    
    llm = MockStreamingLLM(responses=[
        AIMessage(
            content="",
            tool_calls=[{
                "name": "search_flights",
                "args": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
                "id": "call_search_1"
            }]
        ),
        AIMessage(content="I found flight VN310 for $452.0.")
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "search flights to NRT", "sessionId": "session-readonly"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            tool_call_events = [e for e in events if e["event"] == "tool_call"]
            tool_result_events = [e for e in events if e["event"] == "tool_result"]
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(tool_call_events) == 1
            assert tool_call_events[0]["data"]["name"] == "search_flights"
            
            assert len(tool_result_events) == 1
            assert tool_result_events[0]["data"]["name"] == "search_flights"
            assert "flights" in tool_result_events[0]["data"]["result"]
            
            assert len(token_events) > 0
            assert "".join([e["data"]["content"] for e in token_events]) == "I found flight VN310 for $452.0."
            assert len(done_events) == 1


@pytest.mark.asyncio
async def test_sse_confirm_gate_suspension(mock_nestjs_client):
    headers = get_auth_headers()
    
    llm = MockStreamingLLM(responses=[
        AIMessage(
            content="",
            tool_calls=[{
                "name": "book_flight",
                "args": {"flight_number": "VN310", "date": "2026-07-15"},
                "id": "call_book_1"
            }]
        )
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "book flight VN310", "sessionId": "session-gate"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            tool_call_events = [e for e in events if e["event"] == "tool_call"]
            confirm_events = [e for e in events if e["event"] == "confirmation_required"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(tool_call_events) == 0
            
            assert len(confirm_events) == 1
            assert confirm_events[0]["data"]["name"] == "book_flight"
            assert confirm_events[0]["data"]["id"] == "call_book_1"
            
            assert len(done_events) == 0


@pytest.mark.asyncio
async def test_sse_resume_approved(mock_nestjs_client):
    headers = get_auth_headers()
    session_id = "session-resume-approve"
    
    llm_initial = MockStreamingLLM(responses=[
        AIMessage(
            content="",
            tool_calls=[{
                "name": "book_flight",
                "args": {"flight_number": "VN310", "date": "2026-07-15"},
                "id": "call_book_approve"
            }]
        )
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm_initial):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            await ac.post(
                "/chat/stream",
                json={"message": "book flight VN310", "sessionId": session_id},
                headers=headers
            )

    llm_resume = MockStreamingLLM(responses=[
        AIMessage(content="I have booked flight VN310 for you.")
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm_resume):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"confirmed": True, "sessionId": session_id},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            tool_result_events = [e for e in events if e["event"] == "tool_result"]
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(tool_result_events) == 1
            assert tool_result_events[0]["data"]["name"] == "book_flight"
            assert "booked" in tool_result_events[0]["data"]["result"]
            
            assert len(token_events) > 0
            assert "".join([e["data"]["content"] for e in token_events]) == "I have booked flight VN310 for you."
            assert len(done_events) == 1
            assert done_events[0]["data"]["sessionId"] == session_id


@pytest.mark.asyncio
async def test_sse_resume_aborted(mock_nestjs_client):
    headers = get_auth_headers()
    session_id = "session-resume-abort"
    
    llm_initial = MockStreamingLLM(responses=[
        AIMessage(
            content="",
            tool_calls=[{
                "name": "book_flight",
                "args": {"flight_number": "VN310", "date": "2026-07-15"},
                "id": "call_book_abort"
            }]
        )
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm_initial):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            await ac.post(
                "/chat/stream",
                json={"message": "book flight VN310", "sessionId": session_id},
                headers=headers
            )

    llm_resume = MockStreamingLLM(responses=[
        AIMessage(content="I have cancelled the booking request.")
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm_resume):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"confirmed": False, "sessionId": session_id},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            tool_result_events = [e for e in events if e["event"] == "tool_result"]
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(tool_result_events) == 0
            
            assert len(token_events) > 0
            assert "".join([e["data"]["content"] for e in token_events]) == "I have cancelled the booking request."
            assert len(done_events) == 1


@pytest.mark.asyncio
async def test_sse_gateway_error(mock_nestjs_client):
    headers = get_auth_headers()
    
    mock_nestjs_client.get_gateway_flights_search.side_effect = Exception("Gateway Timeout")
    
    llm = MockStreamingLLM(responses=[
        AIMessage(
            content="",
            tool_calls=[{
                "name": "search_flights",
                "args": {"origin": "HAN", "destination": "NRT", "date": "2026-07-15"},
                "id": "call_err_1"
            }]
        ),
        AIMessage(content="I encountered a gateway error.")
    ])

    with patch("agent.streaming.sse.NestJSClient", return_value=mock_nestjs_client), \
         patch("agent.graph.nodes.get_chat_model", return_value=llm):
        
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.post(
                "/chat/stream",
                json={"message": "search flights to NRT", "sessionId": "session-error-gate"},
                headers=headers
            )
            assert response.status_code == 200
            
            lines = [line async for line in response.aiter_lines()]
            events = parse_sse(lines)
            
            tool_call_events = [e for e in events if e["event"] == "tool_call"]
            tool_result_events = [e for e in events if e["event"] == "tool_result"]
            token_events = [e for e in events if e["event"] == "token"]
            done_events = [e for e in events if e["event"] == "done"]
            
            assert len(tool_call_events) == 1
            assert len(tool_result_events) == 1
            assert "temporarily unavailable" in tool_result_events[0]["data"]["result"]
            
            assert len(token_events) > 0
            assert len(done_events) == 1
