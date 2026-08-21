"""Deterministic, local OpenAI-compatible model boundary for T093 browser tests.

The server intentionally has no model dependency.  It returns only stable
responses needed by the agent's guardrail, router, and tool-call flows.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3012
CHAT_PATHS = frozenset({"/v1/chat/completions", "/chat/completions"})

_AIRPORTS = {
    "bangkok": "BKK",
    "hanoi": "HAN",
    "ho chi minh": "SGN",
    "london": "LHR",
    "los angeles": "LAX",
    "new york": "JFK",
    "osaka": "KIX",
    "paris": "CDG",
    "seoul": "ICN",
    "san francisco": "SFO",
    "singapore": "SIN",
    "tokyo": "NRT",
}


def _text_content(content: Any) -> str:
    """Extract text from either a plain OpenAI message or content blocks."""

    if isinstance(content, str):
        return content
    if isinstance(content, Sequence) and not isinstance(content, (bytes, bytearray, str)):
        parts: list[str] = []
        for block in content:
            if isinstance(block, Mapping):
                value = block.get("text")
                if isinstance(value, str):
                    parts.append(value)
        return " ".join(parts)
    return ""


def _message_text(message: Mapping[str, Any]) -> str:
    return _text_content(message.get("content"))


def _latest_user_text(messages: Sequence[Mapping[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return _message_text(message)
    return ""


def _latest_tool_name(messages: Sequence[Mapping[str, Any]]) -> str:
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if message.get("role") == "tool":
            name = message.get("name")
            if isinstance(name, str):
                return name
            tool_call_id = message.get("tool_call_id")
            if isinstance(tool_call_id, str):
                for previous in reversed(messages[:index]):
                    tool_calls = previous.get("tool_calls")
                    if not isinstance(tool_calls, Sequence) or isinstance(
                        tool_calls, (str, bytes, bytearray)
                    ):
                        continue
                    for tool_call in tool_calls:
                        if (
                            not isinstance(tool_call, Mapping)
                            or tool_call.get("id") != tool_call_id
                        ):
                            continue
                        function = tool_call.get("function")
                        if isinstance(function, Mapping) and isinstance(function.get("name"), str):
                            return str(function["name"])
            return ""
    return ""


def _is_guardrail_request(messages: Sequence[Mapping[str, Any]]) -> bool:
    prompt = " ".join(_message_text(message).lower() for message in messages)
    return "security classifier" in prompt or "safe or unsafe" in prompt


def _is_router_schema(body: Mapping[str, Any]) -> bool:
    response_format = body.get("response_format")
    if isinstance(response_format, Mapping):
        schema = response_format.get("json_schema")
        if isinstance(schema, Mapping) and "route" in str(schema.get("name", "")).lower():
            return True
        if response_format.get("type") in {"json_object", "json_schema"}:
            return True

    tools = body.get("tools")
    if not isinstance(tools, Sequence) or isinstance(tools, (str, bytes, bytearray)):
        return False
    for tool in tools:
        if not isinstance(tool, Mapping):
            continue
        function = tool.get("function")
        if not isinstance(function, Mapping):
            continue
        name = str(function.get("name", "")).lower()
        parameters = function.get("parameters")
        properties = parameters.get("properties", {}) if isinstance(parameters, Mapping) else {}
        if "route" in name or {"intent", "confidence"}.issubset(properties):
            return True
    return False


def _router_decision(user_text: str) -> dict[str, Any]:
    lowered = user_text.lower()
    commitment = bool(
        re.search(
            r"\b(check\s*out|checkout|book|booking|purchase|buy|reserve|reservation)\b",
            lowered,
        )
    )
    selection_match = re.search(
        r"\b(?:flight|option|offer)\s*(?:number|no\.?|#)?\s*(\d+)\b|\b(?:number|option|offer)\s+(\d+)\b",
        lowered,
    )
    selection_index = (
        next(
            (int(value) for value in selection_match.groups() if value is not None),
            1,
        )
        if selection_match
        else None
    )

    decision: dict[str, Any] = {
        "intent": "CHECKOUT" if commitment else "SEARCH",
        "confidence": 0.99,
        "isCommitment": commitment,
    }
    if commitment and selection_index is not None:
        decision["selectionIndex"] = selection_index
    return decision


def _airport_code(value: str) -> str:
    clean = re.sub(r"[^a-zA-Z ]", "", value).strip().lower()
    if clean in _AIRPORTS:
        return _AIRPORTS[clean]
    code_match = re.search(r"\b([a-zA-Z]{3})\b", value)
    return code_match.group(1).upper() if code_match else "HAN"


def _search_arguments(user_text: str) -> dict[str, Any]:
    route_match = re.search(
        r"\bfrom\s+(.+?)\s+to\s+(.+?)(?=\s+(?:on|for|departing|leaving)\b|$)",
        user_text,
        flags=re.IGNORECASE,
    )
    origin = _airport_code(route_match.group(1)) if route_match else "HAN"
    destination = _airport_code(route_match.group(2)) if route_match else "NRT"

    iso_date = re.search(r"\b(20\d{2}-\d{2}-\d{2})\b", user_text)
    if iso_date:
        date = iso_date.group(1)
    else:
        month_date = re.search(
            r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b",
            user_text,
            flags=re.IGNORECASE,
        )
        if month_date:
            parsed = datetime.strptime(
                f"2026 {month_date.group(1)} {month_date.group(2)}", "%Y %B %d"
            )
            date = parsed.strftime("%Y-%m-%d")
        else:
            date = "2026-07-15"

    passenger_match = re.search(r"\b(\d+)\s+passengers?\b", user_text, flags=re.IGNORECASE)
    passengers = int(passenger_match.group(1)) if passenger_match else 1
    return {
        "origin": origin,
        "destination": destination,
        "date": date,
        "passengers": passengers,
    }


def _function_tool_call(name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": f"call_t093_{name}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, separators=(",", ":")),
        },
    }


def _openai_response(
    body: Mapping[str, Any],
    *,
    content: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    finish_reason = "stop"
    if tool_calls:
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
    return {
        "id": "chatcmpl-t093-mimo",
        "object": "chat.completion",
        "created": 0,
        "model": body.get("model") or "mimo",
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


class _MimoRequestHandler(BaseHTTPRequestHandler):
    """HTTP handler with intentionally silent request logging."""

    server_version = "T093Mimo"
    sys_version = ""

    def log_message(self, _format: str, *_args: Any) -> None:
        # Never emit request paths, headers, bodies, or model values in test logs.
        return

    def do_GET(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/health":
            self._send_json(
                404, {"error": {"message": "Not found", "type": "invalid_request_error"}}
            )
            return
        self._send_json(200, {"status": "ok", "ok": True})

    def do_POST(self) -> None:  # noqa: N802
        if urlsplit(self.path).path not in CHAT_PATHS:
            self._send_json(
                404, {"error": {"message": "Not found", "type": "invalid_request_error"}}
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 2_000_000:
                raise ValueError("request body too large")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, Mapping):
                raise ValueError("request must be a JSON object")
            response = self._completion_response(body)
        except (ValueError, TypeError, json.JSONDecodeError):
            self._send_json(
                400, {"error": {"message": "Invalid request", "type": "invalid_request_error"}}
            )
            return
        if body.get("stream") is True:
            self._send_stream(response)
        else:
            self._send_json(200, response)

    def _completion_response(self, body: Mapping[str, Any]) -> dict[str, Any]:
        raw_messages = body.get("messages", [])
        messages = raw_messages if isinstance(raw_messages, Sequence) else []
        messages = [message for message in messages if isinstance(message, Mapping)]
        latest_user = _latest_user_text(messages)

        if _is_guardrail_request(messages):
            return _openai_response(body, content="SAFE")

        tool_result_name = _latest_tool_name(messages)
        if tool_result_name in {"search_flights", "signal_checkout_intent"}:
            return _openai_response(
                body,
                content=(
                    "I found the available flight options. Tell me which option you want to book."
                    if tool_result_name == "search_flights"
                    else "Checkout is ready for the selected flight."
                ),
            )

        if _is_router_schema(body):
            decision = _router_decision(latest_user)
            tools = body.get("tools")
            if isinstance(tools, Sequence) and not isinstance(tools, (str, bytes, bytearray)):
                router_name = next(
                    (
                        str(tool["function"]["name"])
                        for tool in tools
                        if isinstance(tool, Mapping)
                        and isinstance(tool.get("function"), Mapping)
                        and (
                            "route" in str(tool["function"].get("name", "")).lower()
                            or "intent" in str(tool["function"].get("parameters", {}))
                        )
                    ),
                    None,
                )
                if router_name:
                    return _openai_response(
                        body, tool_calls=[_function_tool_call(router_name, decision)]
                    )
            return _openai_response(body, content=json.dumps(decision, separators=(",", ":")))

        available_tools = body.get("tools")
        tool_names = (
            {
                str(tool["function"]["name"])
                for tool in available_tools
                if isinstance(tool, Mapping) and isinstance(tool.get("function"), Mapping)
            }
            if isinstance(available_tools, Sequence)
            and not isinstance(available_tools, (str, bytes, bytearray))
            else set()
        )

        if (
            "signal_checkout_intent" in tool_names
            and _router_decision(latest_user)["intent"] == "CHECKOUT"
        ):
            index = _router_decision(latest_user).get("selectionIndex") or 1
            return _openai_response(
                body,
                tool_calls=[_function_tool_call("signal_checkout_intent", {"offer_index": index})],
            )
        if "search_flights" in tool_names and _router_decision(latest_user)["intent"] == "SEARCH":
            return _openai_response(
                body,
                tool_calls=[_function_tool_call("search_flights", _search_arguments(latest_user))],
            )
        return _openai_response(body, content="I can help with your flight plans.")

    def _send_json(self, status: int, payload: Mapping[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_stream(self, response: Mapping[str, Any]) -> None:
        """Emit the minimal OpenAI SSE chunk sequence consumed by LangChain."""

        choices = response.get("choices")
        choice = choices[0] if isinstance(choices, Sequence) and choices else {}
        message = choice.get("message", {}) if isinstance(choice, Mapping) else {}
        delta: dict[str, Any] = {"role": "assistant"}
        content = message.get("content") if isinstance(message, Mapping) else None
        if isinstance(content, str):
            delta["content"] = content
        tool_calls = message.get("tool_calls") if isinstance(message, Mapping) else None
        if isinstance(tool_calls, Sequence) and not isinstance(tool_calls, (str, bytes, bytearray)):
            delta["tool_calls"] = tool_calls

        first_chunk = {
            "id": response.get("id", "chatcmpl-t093-mimo"),
            "object": "chat.completion.chunk",
            "created": response.get("created", 0),
            "model": response.get("model", "t093"),
            "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        }
        finish_chunk = {
            "id": response.get("id", "chatcmpl-t093-mimo"),
            "object": "chat.completion.chunk",
            "created": response.get("created", 0),
            "model": response.get("model", "t093"),
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": choice.get("finish_reason", "stop")
                    if isinstance(choice, Mapping)
                    else "stop",
                }
            ],
        }
        payload = (
            "".join(
                f"data: {json.dumps(chunk, separators=(',', ':'))}\n\n"
                for chunk in (first_chunk, finish_chunk)
            )
            + "data: [DONE]\n\n"
        )
        encoded = payload.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class MimoServer:
    """Small context-manager wrapper useful for in-process smoke tests."""

    def __init__(self, host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> None:
        self.httpd = ThreadingHTTPServer((host, port), _MimoRequestHandler)
        self._thread: threading.Thread | None = None

    @property
    def host(self) -> str:
        return str(self.httpd.server_address[0])

    @property
    def port(self) -> int:
        return int(self.httpd.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}/v1"

    def start(self) -> "MimoServer":
        if self._thread is None:
            self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
            self._thread.start()
        return self

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None

    def __enter__(self) -> "MimoServer":
        return self.start()

    def __exit__(self, _exc_type: Any, _exc_value: Any, _traceback: Any) -> None:
        self.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the deterministic T093 Mimo test server.")
    parser.add_argument("--host", default=os.getenv("T093_MIMO_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.getenv("T093_MIMO_PORT", DEFAULT_PORT)))
    args = parser.parse_args()

    server = MimoServer(args.host, args.port)
    print(f"T093 Mimo server listening at {server.base_url}", flush=True)
    try:
        server.httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()


if __name__ == "__main__":
    main()
