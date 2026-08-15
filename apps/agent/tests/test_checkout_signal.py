import json
import socket
import urllib.request
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from agent.tools.signal_checkout_intent import signal_checkout_intent


class TestCheckoutSignalValidCases:
    def test_signal_checkout_intent_with_offer_index(self):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}, {"id": "offer_3"}]
            }
        }
        result = signal_checkout_intent.func(offer_index=2, state=state)
        assert isinstance(result, str)
        data = json.loads(result)
        assert "signal" in data
        assert data["signal"] == {
            "intent": "checkout",
            "offer_index": 2,
            "selected_index": 2,
        }

    def test_signal_checkout_intent_with_selected_index(self):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}]
            }
        }
        result = signal_checkout_intent.func(selected_index=1, state=state)
        assert isinstance(result, str)
        data = json.loads(result)
        assert "signal" in data
        assert data["signal"] == {
            "intent": "checkout",
            "offer_index": 1,
            "selected_index": 1,
        }

    def test_signal_checkout_intent_selected_index_precedence(self):
        # selected_index takes precedence over offer_index if both provided
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}, {"id": "offer_3"}]
            }
        }
        result = signal_checkout_intent.func(
            offer_index=1, selected_index=3, state=state
        )
        assert isinstance(result, str)
        data = json.loads(result)
        assert data["signal"]["offer_index"] == 3
        assert data["signal"]["selected_index"] == 3

    def test_signal_checkout_intent_with_fallback_snapshot_key(self):
        # Falls back to state["snapshot"] if "trusted_snapshot" is absent
        state = {
            "snapshot": {
                "results": [{"id": "offer_1"}]
            }
        }
        result = signal_checkout_intent.func(offer_index=1, state=state)
        data = json.loads(result)
        assert data["signal"] == {
            "intent": "checkout",
            "offer_index": 1,
            "selected_index": 1,
        }


class TestCheckoutSignalOutOfBounds:
    def test_signal_checkout_intent_index_greater_than_results(self):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}]
            }
        }
        result = signal_checkout_intent.func(offer_index=3, state=state)
        assert result == "Invalid offer index. Must be between 1 and 2."

    def test_signal_checkout_intent_large_index(self):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}]
            }
        }
        result = signal_checkout_intent.func(offer_index=999, state=state)
        assert result == "Invalid offer index. Must be between 1 and 1."


class TestCheckoutSignalInvalidIndices:
    @pytest.mark.parametrize("invalid_idx", [0, -1, -5, -100])
    def test_signal_checkout_intent_zero_or_negative_index(self, invalid_idx):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}]
            }
        }
        result = signal_checkout_intent.func(offer_index=invalid_idx, state=state)
        assert result == "Invalid offer index. Must be a positive integer (1..N)."

    @pytest.mark.parametrize("invalid_type", [
        1.5,
        "1",
        "2",
        True,
        False,
        None,
        [],
        {},
        [1],
        {"index": 1},
    ])
    def test_signal_checkout_intent_non_integer_types(self, invalid_type):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}]
            }
        }
        result = signal_checkout_intent.func(offer_index=invalid_type, state=state)
        assert result == "Invalid offer index. Must be a positive integer (1..N)."

    def test_signal_checkout_intent_no_arguments(self):
        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}]
            }
        }
        result = signal_checkout_intent.func(state=state)
        assert result == "Invalid offer index. Must be a positive integer (1..N)."


class TestCheckoutSignalMissingOrEmptySnapshot:
    def test_state_is_none(self):
        result = signal_checkout_intent.func(offer_index=1, state=None)
        assert result == "No search results available. Please perform a search first."

    def test_state_is_empty_dict(self):
        result = signal_checkout_intent.func(offer_index=1, state={})
        assert result == "No search results available. Please perform a search first."

    def test_state_is_non_dict(self):
        result = signal_checkout_intent.func(offer_index=1, state="invalid_state")
        assert result == "No search results available. Please perform a search first."

    def test_state_missing_snapshot_keys(self):
        state = {"user_id": "u123", "messages": []}
        result = signal_checkout_intent.func(offer_index=1, state=state)
        assert result == "No search results available. Please perform a search first."

    def test_snapshot_is_not_a_dict(self):
        state = {"trusted_snapshot": "invalid_snapshot_type"}
        result = signal_checkout_intent.func(offer_index=1, state=state)
        assert result == "No search results available. Please perform a search first."

    def test_results_is_empty_list(self):
        state = {"trusted_snapshot": {"results": []}}
        result = signal_checkout_intent.func(offer_index=1, state=state)
        assert result == "No search results available. Please perform a search first."

    def test_results_is_not_a_list(self):
        state = {"trusted_snapshot": {"results": None}}
        result = signal_checkout_intent.func(offer_index=1, state=state)
        assert result == "No search results available. Please perform a search first."


class TestCheckoutSignalZeroIO:
    def test_zero_io_side_effects(self, monkeypatch):
        """Strictly assert no network, Redis, DB, or external API calls happen during tool execution."""
        mock_httpx_send = MagicMock(side_effect=RuntimeError("httpx.Client.send must NOT be called"))
        mock_async_send = AsyncMock(side_effect=RuntimeError("httpx.AsyncClient.send must NOT be called"))
        mock_urllib_open = MagicMock(side_effect=RuntimeError("urllib.request.urlopen must NOT be called"))
        mock_socket_connect = MagicMock(side_effect=RuntimeError("socket.connect must NOT be called"))

        monkeypatch.setattr(httpx.Client, "send", mock_httpx_send)
        monkeypatch.setattr(httpx.AsyncClient, "send", mock_async_send)
        monkeypatch.setattr(urllib.request, "urlopen", mock_urllib_open)
        monkeypatch.setattr(socket.socket, "connect", mock_socket_connect)

        import agent.infrastructure.redis as redis_mod
        mock_redis = MagicMock()
        mock_redis.get.side_effect = RuntimeError("Redis GET must NOT be called")
        mock_redis.set.side_effect = RuntimeError("Redis SET must NOT be called")
        monkeypatch.setattr(redis_mod, "_redis_client", mock_redis)

        state = {
            "trusted_snapshot": {
                "results": [{"id": "offer_1"}, {"id": "offer_2"}]
            }
        }

        # Invocation should execute purely in-memory
        result = signal_checkout_intent.func(offer_index=1, state=state)
        data = json.loads(result)
        assert data["signal"]["offer_index"] == 1

        # Check mock calls
        assert mock_httpx_send.call_count == 0
        assert mock_async_send.call_count == 0
        assert mock_urllib_open.call_count == 0
        assert mock_socket_connect.call_count == 0
        assert mock_redis.get.call_count == 0
        assert mock_redis.set.call_count == 0
