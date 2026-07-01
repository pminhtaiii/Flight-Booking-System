import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from agent.memory.manager import MemoryManager
from agent.tools.nestjs_client import NestJSClient

def test_token_counting():
    # Verify token counting is functional using cl100k_base
    mgr = MemoryManager(window_size=2, token_budget=10)
    # The word "hello" is typically 1 token in cl100k_base
    assert mgr.count_tokens("hello") == 1
    # Check that a longer string returns more tokens
    assert mgr.count_tokens("hello world travel planning") > 1

@pytest.mark.asyncio
async def test_check_and_summarize_no_trigger():
    # If total messages <= window_size, it shouldn't trigger anything
    mgr = MemoryManager(window_size=3, token_budget=10)
    client = MagicMock(spec=NestJSClient)
    
    # Mock get_memory to return total count less than or equal to window_size
    client.get_memory = AsyncMock(return_value={
        "summary": None,
        "recentMessages": [
            {"sender": "USER", "content": "hi"},
            {"sender": "AGENT", "content": "hello"}
        ],
        "totalMessageCount": 2
    })
    
    await mgr.check_and_summarize("session-123", client)
    
    # get_memory should be called once with recentCount=window_size (3)
    client.get_memory.assert_called_once_with("session-123", recent_count=3)
    # It should not fetch all messages because totalMessageCount (2) <= window_size (3)
    assert client.get_memory.call_count == 1
    # It should not generate summary
    client.create_message.assert_not_called()

@pytest.mark.asyncio
async def test_check_and_summarize_under_budget():
    # If total messages > window_size, but token count of older messages <= budget, it shouldn't trigger
    mgr = MemoryManager(window_size=2, token_budget=100)
    client = MagicMock(spec=NestJSClient)
    
    # Mock calls for get_memory: first with window_size, then with total_count
    # In both cases, return 3 messages total, but older messages ("hi" - 1 token) is well under 100 budget
    client.get_memory = AsyncMock(side_effect=[
        {
            "summary": None,
            "recentMessages": [
                {"sender": "USER", "content": "how are you?"},
                {"sender": "AGENT", "content": "good"}
            ],
            "totalMessageCount": 3
        },
        {
            "summary": None,
            "recentMessages": [
                {"sender": "USER", "content": "hi"}, # older message
                {"sender": "USER", "content": "how are you?"},
                {"sender": "AGENT", "content": "good"}
            ],
            "totalMessageCount": 3
        }
    ])
    
    await mgr.check_and_summarize("session-123", client)
    
    assert client.get_memory.call_count == 2
    client.create_message.assert_not_called()

@pytest.mark.asyncio
async def test_check_and_summarize_exceeds_budget():
    # If total messages > window_size and token count of older messages > budget, it should trigger summarization
    mgr = MemoryManager(window_size=2, token_budget=5) # very low budget
    client = MagicMock(spec=NestJSClient)
    
    client.get_memory = AsyncMock(side_effect=[
        {
            "summary": "Existing summary", # 2 tokens
            "recentMessages": [
                {"sender": "USER", "content": "how are you?"},
                {"sender": "AGENT", "content": "good"}
            ],
            "totalMessageCount": 3
        },
        {
            "summary": "Existing summary",
            "recentMessages": [
                {"sender": "USER", "content": "very long older message about travel planning to Paris"}, # > 5 tokens
                {"sender": "USER", "content": "how are you?"},
                {"sender": "AGENT", "content": "good"}
            ],
            "totalMessageCount": 3
        }
    ])
    
    client.create_message = AsyncMock(return_value={"id": "msg-summary"})
    
    # Mock ChatOpenAI instance
    mock_model = MagicMock()
    mock_response = MagicMock()
    mock_response.content = "New consolidated summary"
    mock_model.ainvoke = AsyncMock(return_value=mock_response)
    
    with patch("agent.memory.manager.get_chat_model", return_value=mock_model):
        await mgr.check_and_summarize("session-123", client)
        
        # Verify the model was called to summarize
        mock_model.ainvoke.assert_called_once()
        # Verify the prompt includes the older message and existing summary
        called_args = mock_model.ainvoke.call_args[0][0]
        called_prompt = called_args[0].content
        assert "Existing Summary:" in called_prompt
        assert "Existing summary" in called_prompt
        assert "very long older message about travel planning to Paris" in called_prompt
        
        # Verify it persisted the new summary
        client.create_message.assert_called_once_with(
            session_id="session-123",
            sender="AGENT",
            message_type="SUMMARY",
            content="New consolidated summary"
        )

@pytest.mark.asyncio
async def test_summarization_failure_fallback():
    # If summarization LLM call fails, it should catch the exception and fall back to truncation (do not crash)
    mgr = MemoryManager(window_size=2, token_budget=5)
    client = MagicMock(spec=NestJSClient)
    
    client.get_memory = AsyncMock(side_effect=[
        {
            "summary": "Existing summary",
            "recentMessages": [
                {"sender": "USER", "content": "how are you?"},
                {"sender": "AGENT", "content": "good"}
            ],
            "totalMessageCount": 3
        },
        {
            "summary": "Existing summary",
            "recentMessages": [
                {"sender": "USER", "content": "very long older message about travel planning to Paris"},
                {"sender": "USER", "content": "how are you?"},
                {"sender": "AGENT", "content": "good"}
            ],
            "totalMessageCount": 3
        }
    ])
    
    client.create_message = AsyncMock()
    
    mock_model = MagicMock()
    mock_model.ainvoke = AsyncMock(side_effect=RuntimeError("LLM offline"))
    
    with patch("agent.memory.manager.get_chat_model", return_value=mock_model):
        # This call should not raise an exception
        await mgr.check_and_summarize("session-123", client)
        
        mock_model.ainvoke.assert_called_once()
        # It should NOT call create_message to persist because it failed
        client.create_message.assert_not_called()
