import pytest
from langchain_core.messages import ToolMessage
from agent.tools.signal_checkout_intent import signal_checkout_intent
from typing import Dict, Any

def test_signal_checkout_intent_valid_index():
    # Setup state
    state = {
        "trusted_snapshot": {
            "results": [{"id": "offer_1"}, {"id": "offer_2"}]
        }
    }
    
    # Call tool
    result = signal_checkout_intent.func(offer_index=2, state=state)
    import json
    
    # Check result
    assert isinstance(result, str)
    data = json.loads(result)
    assert "signal" in data
    assert data["signal"] == {"intent": "checkout", "offer_index": 2}

def test_signal_checkout_intent_invalid_index():
    # Setup state
    state = {
        "trusted_snapshot": {
            "results": [{"id": "offer_1"}]
        }
    }
    
    # Call tool with out of bounds index
    result = signal_checkout_intent.func(offer_index=5, state=state)
    
    # Check result
    assert isinstance(result, str)
    assert "Invalid offer index" in result

def test_signal_checkout_intent_no_snapshot():
    # Setup state
    state = {}
    
    # Call tool
    result = signal_checkout_intent.func(offer_index=1, state=state)
    
    # Check result
    assert isinstance(result, str)
    assert "No search results available" in result
