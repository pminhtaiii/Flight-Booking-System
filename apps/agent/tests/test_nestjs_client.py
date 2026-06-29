import pytest
import httpx
from unittest.mock import AsyncMock, patch
from agent.tools.nestjs_client import NestJSClient

@pytest.mark.asyncio
async def test_create_session():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    
    req = httpx.Request("POST", "http://localhost:3001/api/chat/sessions")
    mock_response = httpx.Response(201, json={"id": "session-123", "title": "New Session"}, request=req)
    
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        
        result = await client.create_session(title="New Session")
        
        assert result == {"id": "session-123", "title": "New Session"}
        mock_post.assert_called_once_with(
            "http://localhost:3001/api/chat/sessions",
            json={"title": "New Session"},
            headers={"Authorization": "Bearer test-token"}
        )

@pytest.mark.asyncio
async def test_create_message():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("POST", "http://localhost:3001/api/chat/sessions/session-123/messages")
    mock_response = httpx.Response(201, json={"id": "msg-123", "content": "hello"}, request=req)
    
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        
        result = await client.create_message(
            session_id="session-123",
            sender="USER",
            message_type="STANDARD",
            content="hello"
        )
        
        assert result == {"id": "msg-123", "content": "hello"}
        mock_post.assert_called_once_with(
            "http://localhost:3001/api/chat/sessions/session-123/messages",
            json={"sender": "USER", "type": "STANDARD", "content": "hello"},
            headers={"Authorization": "Bearer test-token"}
        )

@pytest.mark.asyncio
async def test_create_message_batch():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("POST", "http://localhost:3001/api/chat/sessions/session-123/messages/batch")
    mock_response = httpx.Response(201, json={"messages": [{"id": "msg-123"}]}, request=req)
    
    messages = [
        {"sender": "USER", "type": "STANDARD", "content": "hello"},
        {"sender": "AGENT", "type": "STANDARD", "content": "hi"}
    ]
    
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response
        
        result = await client.create_message_batch(
            session_id="session-123",
            messages=messages
        )
        
        assert result == {"messages": [{"id": "msg-123"}]}
        mock_post.assert_called_once_with(
            "http://localhost:3001/api/chat/sessions/session-123/messages/batch",
            json={"messages": messages},
            headers={"Authorization": "Bearer test-token"}
        )

@pytest.mark.asyncio
async def test_get_memory():
    client = NestJSClient(base_url="http://localhost:3001/api", token="test-token")
    req = httpx.Request("GET", "http://localhost:3001/api/chat/sessions/session-123/memory")
    mock_response = httpx.Response(200, json={"summary": None, "recentMessages": []}, request=req)
    
    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_response
        
        result = await client.get_memory(session_id="session-123", recent_count=20)
        
        assert result == {"summary": None, "recentMessages": []}
        mock_get.assert_called_once_with(
            "http://localhost:3001/api/chat/sessions/session-123/memory",
            params={"recentCount": 20},
            headers={"Authorization": "Bearer test-token"}
        )
