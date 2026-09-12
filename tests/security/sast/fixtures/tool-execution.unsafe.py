"""Unsafe tool execution fixture: directly invokes tool functions bypassing security gateway."""

from typing import Any, Dict


def search_flights(query: str, limit: int = 10) -> Dict[str, Any]:
    return {"query": query, "results": []}


def booking_detail(booking_id: str) -> Dict[str, Any]:
    return {"booking_id": booking_id, "status": "CONFIRMED"}


class UnsafeAgentRunner:
    """Agent node or runner invoking tool directly without security gateway checks."""

    def handle_user_action(self, action_name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if action_name == "search":
            # VIOLATION: Direct tool function execution bypassing gateway
            return search_flights(payload.get("query", ""))
        if action_name == "booking":
            # VIOLATION: Direct tool function execution bypassing gateway
            return booking_detail(payload.get("booking_id", ""))
        raise ValueError(f"Unsupported action: {action_name}")
