"""Graph event interpreter translating LangGraph streams to typed ChatTurnEvents."""

import inspect
import json
from typing import AsyncIterable, AsyncIterator, Optional

from agent.chat_turn.events import (
    ChatTurnEvent,
    TokenEvent,
    TokenPayload,
    ToolCallEvent,
    ToolCallPayload,
    ToolResultEvent,
    ToolResultPayload,
)
from agent.chat_turn.resolver import ToolResultResolver

GUARDRAIL_TOOL_SCHEMA: str = "GUARDRAIL_TOOL_SCHEMA"

HANDOFF_NODES: frozenset[str] = frozenset(
    {
        "create_handoff_token",
        "create_handoff_token_node",
        "validate_handoff",
    }
)

AGENT_NODES: frozenset[str] = frozenset(
    {
        "general",
        "travel",
        "checkout",
        "final_answer",
    }
)


class ProjectionBlockedException(Exception):
    """Raised when projection or tool output is blocked fail-closed."""

    def __init__(
        self,
        error_code: str,
        error_message: str,
        error_detail: Optional[str] = None,
    ) -> None:
        super().__init__(error_message)
        self.error_code = error_code
        self.error_message = error_message
        self.error_detail = error_detail


def _project_public_tool_inputs(raw_args: object) -> dict[str, object]:
    if not isinstance(raw_args, dict):
        return {}
    return {str(k): v for k, v in raw_args.items()}


class GraphEventInterpreter:
    """Interprets LangGraph event stream into domain-typed ChatTurnEvents."""

    def __init__(
        self,
        resolver: ToolResultResolver,
        context: Optional[object] = None,
    ) -> None:
        self.resolver = resolver
        self.context = context

    async def interpret(
        self,
        stream: AsyncIterable[dict[str, object]],
        context: Optional[object] = None,
    ) -> AsyncIterator[ChatTurnEvent]:
        """Translate event stream into ChatTurnEvents with fail-closed projections."""
        effective_context = context if context is not None else self.context

        pending_tool_calls: dict[str, dict[str, object]] = {}
        emitted_tool_call_ids: set[str] = set()
        handled_message_ids: set[object] = set()
        streamed_run_ids: set[str] = set()
        active_model_streamed: bool = False
        streamed_since_last_node_end: bool = False

        async for event in stream:
            if not isinstance(event, dict):
                continue

            kind = event.get("event")
            if not isinstance(kind, str):
                continue

            if kind == "on_chain_start":
                node_name = event.get("name")
                if node_name in AGENT_NODES:
                    streamed_since_last_node_end = False

            elif kind == "on_chat_model_start":
                pass

            elif kind == "on_chat_model_stream":
                run_id = event.get("run_id")
                if isinstance(run_id, str) and run_id:
                    streamed_run_ids.add(run_id)
                active_model_streamed = True
                streamed_since_last_node_end = True
                data = event.get("data")
                chunk = data.get("chunk") if isinstance(data, dict) else None
                chunk_content = getattr(chunk, "content", None) if chunk is not None else None
                if chunk_content is None and isinstance(chunk, dict):
                    chunk_content = chunk.get("content")
                if isinstance(chunk_content, str) and chunk_content:
                    yield TokenEvent(data=TokenPayload(content=chunk_content))

            elif kind == "on_chat_model_end":
                run_id = event.get("run_id")
                has_streamed = (
                    (run_id in streamed_run_ids)
                    if isinstance(run_id, str) and run_id
                    else active_model_streamed
                )
                active_model_streamed = False

                data = event.get("data")
                output = data.get("output") if isinstance(data, dict) else None
                message = output
                if isinstance(output, dict):
                    message = output.get("generations") or output.get("message") or output
                    if isinstance(message, list) and message:
                        message = message[0]
                    if isinstance(message, list) and message:
                        message = message[0]
                    if hasattr(message, "message"):
                        message = message.message

                if message is not None:
                    handled_message_ids.add(id(message))
                    if hasattr(message, "message"):
                        handled_message_ids.add(id(message.message))
                    msg_id = getattr(message, "id", None)
                    if isinstance(msg_id, str) and msg_id:
                        handled_message_ids.add(msg_id)

                if not has_streamed:
                    content = getattr(message, "content", None)
                    if content is None and isinstance(message, dict):
                        content = message.get("content")
                    if isinstance(content, str) and content:
                        yield TokenEvent(data=TokenPayload(content=content))

            elif kind == "on_tool_start":
                active_model_streamed = False
                streamed_since_last_node_end = False

            elif kind == "on_tool_end":
                pass

            elif kind == "on_chain_end":
                node_name = event.get("name")
                if not isinstance(node_name, str):
                    continue

                if node_name in HANDOFF_NODES:
                    data = event.get("data")
                    node_output = data.get("output") if isinstance(data, dict) else None
                    handoff_res = self.resolver.resolve_handoff_node(
                        node_name,
                        node_output,
                        effective_context,
                    )
                    if inspect.isawaitable(handoff_res):
                        resolution = await handoff_res
                    else:
                        resolution = handoff_res

                    if resolution.is_blocked:
                        raise ProjectionBlockedException(
                            error_code=resolution.error_code or "HANDOFF_FAILED",
                            error_message=resolution.error_message
                            or "Checkout handoff could not be created.",
                            error_detail=resolution.error_detail,
                        )

                    if resolution.handoff_event is not None:
                        yield resolution.handoff_event

                elif node_name in AGENT_NODES:
                    data = event.get("data")
                    output = data.get("output") if isinstance(data, dict) else None
                    messages_out = output.get("messages", []) if isinstance(output, dict) else []
                    if isinstance(messages_out, list) and messages_out:
                        for msg in messages_out:
                            tool_calls = getattr(msg, "tool_calls", None)
                            if tool_calls is None and isinstance(msg, dict):
                                tool_calls = msg.get("tool_calls")
                            if isinstance(tool_calls, list):
                                for tool_call in tool_calls:
                                    if isinstance(tool_call, dict):
                                        call_id = tool_call.get("id")
                                        if isinstance(call_id, str) and call_id:
                                            pending_tool_calls[call_id] = tool_call

                        target_message = messages_out[-1]
                        is_handled = id(target_message) in handled_message_ids or (
                            hasattr(target_message, "message")
                            and id(target_message.message) in handled_message_ids
                        )
                        target_id = getattr(target_message, "id", None)
                        if target_id is None and isinstance(target_message, dict):
                            target_id = target_message.get("id")
                        if not is_handled and isinstance(target_id, str) and target_id:
                            is_handled = target_id in handled_message_ids

                        if not is_handled and not streamed_since_last_node_end:
                            content = getattr(target_message, "content", None)
                            if content is None and isinstance(target_message, dict):
                                content = target_message.get("content")
                            if isinstance(content, str) and content:
                                handled_message_ids.add(id(target_message))
                                if isinstance(target_id, str) and target_id:
                                    handled_message_ids.add(target_id)
                                yield TokenEvent(data=TokenPayload(content=content))

                    streamed_since_last_node_end = False

                elif node_name == "tools":
                    data = event.get("data")
                    output = data.get("output") if isinstance(data, dict) else None

                    if isinstance(output, dict) and output.get("tool_blocked") is True:
                        block_key = output.get("tool_block_response_key") or GUARDRAIL_TOOL_SCHEMA
                        raise ProjectionBlockedException(
                            error_code=str(block_key),
                            error_message="Tool result was blocked for safety reasons.",
                        )

                    messages_out = output.get("messages", []) if isinstance(output, dict) else []
                    if isinstance(messages_out, list):
                        for tool_msg in messages_out:
                            is_validated = False
                            if hasattr(tool_msg, "additional_kwargs"):
                                additional_kwargs = tool_msg.additional_kwargs
                                if (
                                    isinstance(additional_kwargs, dict)
                                    and additional_kwargs.get("guardrail_validated") is True
                                ):
                                    is_validated = True
                            elif isinstance(tool_msg, dict):
                                additional_kwargs = tool_msg.get("additional_kwargs")
                                if (
                                    isinstance(additional_kwargs, dict)
                                    and additional_kwargs.get("guardrail_validated") is True
                                ):
                                    is_validated = True
                            if not is_validated:
                                raise ProjectionBlockedException(
                                    error_code=GUARDRAIL_TOOL_SCHEMA,
                                    error_message="Tool result was blocked for safety reasons.",
                                )

                        for tool_message in messages_out:
                            tool_ident = getattr(tool_message, "name", None)
                            if tool_ident is None and isinstance(tool_message, dict):
                                tool_ident = tool_message.get("name")
                            str_tool_ident = str(tool_ident or "")

                            tool_call_id = getattr(tool_message, "tool_call_id", None)
                            if tool_call_id is None and isinstance(tool_message, dict):
                                tool_call_id = tool_message.get("tool_call_id")

                            pending_call = (
                                pending_tool_calls.pop(tool_call_id, None)
                                if isinstance(tool_call_id, str)
                                else None
                            )
                            if (
                                isinstance(tool_call_id, str)
                                and tool_call_id not in emitted_tool_call_ids
                                and isinstance(pending_call, dict)
                            ):
                                tool_input = (
                                    pending_call.get("args", {})
                                    if isinstance(pending_call, dict)
                                    else {}
                                )
                                safe_input = _project_public_tool_inputs(
                                    tool_input,
                                )
                                yield ToolCallEvent(
                                    data=ToolCallPayload(
                                        name=str_tool_ident,
                                        inputs=safe_input,
                                    )
                                )
                                emitted_tool_call_ids.add(tool_call_id)

                            content = getattr(tool_message, "content", None)
                            if content is None and isinstance(tool_message, dict):
                                content = tool_message.get("content")

                            tool_res = self.resolver.resolve(
                                str_tool_ident,
                                content,
                                effective_context,
                            )
                            if inspect.isawaitable(tool_res):
                                resolution = await tool_res
                            else:
                                resolution = tool_res

                            if resolution.is_blocked:
                                raise ProjectionBlockedException(
                                    error_code=resolution.error_code or "TOOL_BLOCKED",
                                    error_message=resolution.error_message
                                    or "Tool resolution was blocked.",
                                    error_detail=resolution.error_detail,
                                )

                            summary_str = (
                                resolution.summary_override
                                if resolution.summary_override is not None
                                else (
                                    content
                                    if isinstance(content, str)
                                    else json.dumps(content, ensure_ascii=False)
                                    if isinstance(content, dict)
                                    else "Tool completed safely."
                                )
                            )
                            yield ToolResultEvent(
                                data=ToolResultPayload(name=str_tool_ident, result=summary_str)
                            )

                            if resolution.follow_up_event is not None:
                                yield resolution.follow_up_event


__all__ = [
    "GraphEventInterpreter",
    "ProjectionBlockedException",
]
