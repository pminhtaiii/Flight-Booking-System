"""Exercise browser-shaped trace continuity through FastAPI into real NestJS."""

from __future__ import annotations

import json
import sys
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from agent.main import app


async def _handoff_event_stream(request: dict, config: dict, **_: object):
    client = config["configurable"]["nestjs_client"]
    response = await client.create_handoff(
        attestation=request["attestation"],
        offer_index=request["offerIndex"],
    )
    yield {
        "event": "on_chain_end",
        "name": "create_handoff_token",
        "data": {
            "output": {
                "action": {
                    "action": "begin_checkout",
                    "handoffToken": response["handoffToken"],
                    "expiresAt": response["expiresAt"],
                    "display": None,
                }
            }
        },
    }


def main() -> int:
    request = json.load(sys.stdin)
    graph = MagicMock()
    graph.astream_events = lambda *_args, **kwargs: _handoff_event_stream(request, kwargs["config"])
    graph.aget_state = AsyncMock(return_value=MagicMock(next=(), values={}))

    guardrails = MagicMock()
    guardrails.validate_message = AsyncMock(return_value=(True, None))
    guardrails.validate_text = AsyncMock(return_value=(True, None, None))
    guardrails.is_healthy.return_value = True
    budget_repository = MagicMock()
    budget_repository.admit_request = AsyncMock()
    snapshot_repository = MagicMock()
    snapshot_repository.get_snapshot = AsyncMock(return_value=None)

    with (
        patch("agent.streaming.sse.graph", graph),
        patch("agent.streaming.sse.get_redis_client", return_value=MagicMock()),
        patch("agent.middleware.rate_limit.get_redis_client", return_value=MagicMock()),
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository",
            return_value=budget_repository,
        ),
        patch("agent.middleware.rate_limit.ChatBudgetRepository", return_value=budget_repository),
        patch("agent.streaming.sse.TrustedSnapshotRepository", return_value=snapshot_repository),
        TestClient(app) as client,
    ):
        app.state.guardrails = guardrails
        app.state.message_queue = None
        response = client.post(
            "/chat/stream",
            headers={
                "Origin": "http://localhost:3000",
                "Authorization": f"Bearer {request['token']}",
                "X-Trace-Id": request["traceId"],
                "X-Correlation-Id": request["correlationId"],
                "Content-Type": "application/json",
            },
            json={
                "message": "continue with selected flight",
                "sessionId": request["sessionId"],
            },
        )

    if response.status_code != 200:
        detail = None
        try:
            response_data = response.json()
            detail = response_data.get("detail") or response_data.get("message")
        except (AttributeError, ValueError):
            pass
        error_class = {
            "CHAT_CONTROL_PLANE_UNAVAILABLE": "control_plane_unavailable",
            "NestJS API unavailable": "session_create_unavailable",
            "NestJS API memory service unavailable": "memory_unavailable",
            "CHAT_SESSION_NOT_FOUND": "session_not_found",
        }.get(detail, "stream_status_failed")
        sys.stdout.write(
            json.dumps(
                {"ok": False, "error": error_class, "status": response.status_code},
                separators=(",", ":"),
            )
        )
        return 1
    if "event: ACTION_HANDOFF" not in response.text:
        allowed_events = {
            "ACTION_HANDOFF",
            "done",
            "error",
            "token",
            "tool_call",
            "tool_result",
            "flight_results",
        }
        observed_events = [
            event_name
            for line in response.text.splitlines()
            if line.startswith("event:")
            for event_name in [line.partition(":")[2].strip()]
            if event_name in allowed_events
        ]
        sys.stdout.write(
            json.dumps(
                {"ok": False, "error": "action_event_missing", "events": observed_events},
                separators=(",", ":"),
            )
        )
        return 1

    sys.stdout.write('{"ok":true}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
