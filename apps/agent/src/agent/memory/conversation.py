"""Conversation memory implementation for bounded window history and safety validation.

Manages safe conversation context retrieval, guardrail re-scanning,
fail-closed error mapping, and background compaction scheduling.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

from agent.guardrails.base import AdmissionContext
from agent.memory.manager import MemoryManager
from agent.tools.nestjs_client import NestJSClient

if TYPE_CHECKING:
    from agent.guardrails.gateway import GuardrailGateway

# Ensure agent settings singleton is initialized if available
try:
    from agent.config import get_settings

    get_settings()
except Exception:
    pass

logger = logging.getLogger("agent.memory.conversation")


@dataclass
class ValidatedConversationContext:
    """Bounded, security-validated conversation history and summary."""

    history: list[dict[str, object]]
    summary: Optional[str | dict[str, object]] = None
    total_message_count: int = 0


class ContextBlockedException(Exception):
    """Raised when historical conversation context contains unsafe content."""

    def __init__(
        self,
        error_message: str = "Historical conversation context contains unsafe content.",
        error_code: str = "GUARDRAIL_INPUT_INJECTION",
    ) -> None:
        super().__init__(error_message)
        self.error_message = error_message
        self.error_code = error_code


class SessionNotFoundException(Exception):
    """Raised when the requested chat session is not found in backend store."""

    def __init__(
        self,
        error_message: str = "Chat session not found.",
        error_code: str = "CHAT_SESSION_NOT_FOUND",
    ) -> None:
        super().__init__(error_message)
        self.error_message = error_message
        self.error_code = error_code


class MemoryPersistenceException(Exception):
    """Raised when fetching or persisting chat memory fails."""

    def __init__(
        self,
        error_message: str = "Failed to fetch chat session memory.",
        error_code: str = "PERSISTENCE_ERROR",
    ) -> None:
        super().__init__(error_message)
        self.error_message = error_message
        self.error_code = error_code


class ConversationMemory:
    """Conversation memory coordinator supporting window retrieval, guardrail scans, and compaction."""

    def __init__(
        self,
        settings: Optional[object] = None,
        gateway: Optional[GuardrailGateway] = None,
        window_size: Optional[int] = None,
        token_budget: Optional[int] = None,
    ) -> None:
        if settings is None:
            try:
                from agent.config import settings as default_settings

                resolved_settings: Optional[object] = default_settings
            except Exception:
                resolved_settings = None
        else:
            resolved_settings = settings

        if window_size is not None:
            self.window_size = window_size
        else:
            val = getattr(resolved_settings, "MEMORY_WINDOW_SIZE", 20)
            self.window_size = int(val) if val is not None else 20

        if token_budget is not None:
            self.token_budget = token_budget
        else:
            val = getattr(resolved_settings, "MEMORY_TOKEN_BUDGET", 4000)
            self.token_budget = int(val) if val is not None else 4000

        self.gateway = gateway
        self.settings = resolved_settings

    async def get_context(
        self,
        session_id: str,
        client: NestJSClient,
        admission_context: AdmissionContext,
    ) -> ValidatedConversationContext:
        """Fetch sliding memory window, rescan through guardrails, and return validated context."""
        try:
            memory_data = await client.get_memory(session_id, recent_count=self.window_size)
        except Exception as exc:
            err_str = str(exc)
            if "NOT_FOUND" in err_str or "404" in err_str:
                raise SessionNotFoundException(
                    "Chat session not found.",
                    error_code="CHAT_SESSION_NOT_FOUND",
                ) from exc
            raise MemoryPersistenceException(
                "Failed to fetch chat session memory.",
                error_code="PERSISTENCE_ERROR",
            ) from exc

        if isinstance(memory_data, dict):
            raw_history = memory_data.get("recentMessages", [])
            history: list[dict[str, object]] = raw_history if isinstance(raw_history, list) else []
            summary: Optional[str | dict[str, object]] = memory_data.get("summary", None)
            raw_count = memory_data.get("totalMessageCount", 0)
            total_message_count: int = int(raw_count) if isinstance(raw_count, (int, float)) else 0
        else:
            history = []
            summary = None
            total_message_count = 0

        if self.gateway is not None:
            if summary is not None:
                summary_content = ""
                if isinstance(summary, str):
                    summary_content = summary
                elif isinstance(summary, dict):
                    val = summary.get("content")
                    summary_content = str(val) if val is not None else str(summary)
                elif hasattr(summary, "content"):
                    val = getattr(summary, "content")
                    summary_content = str(val) if val is not None else str(summary)
                else:
                    summary_content = str(summary)

                if summary_content:
                    try:
                        summary_decision = await self.gateway.validate_input(
                            admission_context, str(summary_content)
                        )
                        if (
                            summary_decision is None
                            or getattr(summary_decision, "status", None) == "BLOCK"
                        ):
                            summary = None
                    except Exception as exc:
                        logger.warning(
                            "Guardrail validation of historical summary failed closed: %s",
                            exc,
                        )
                        summary = None

            for msg in history:
                msg_content: Optional[str] = None
                if isinstance(msg, dict):
                    raw_val = msg.get("content")
                    if isinstance(raw_val, str):
                        msg_content = raw_val
                elif hasattr(msg, "content"):
                    raw_val = getattr(msg, "content")
                    if isinstance(raw_val, str):
                        msg_content = raw_val

                if not msg_content:
                    continue

                try:
                    decision = await self.gateway.validate_input(admission_context, msg_content)
                except Exception as exc:
                    raise ContextBlockedException(
                        error_message="Historical conversation context contains unsafe content.",
                        error_code="GUARDRAIL_INPUT_INJECTION",
                    ) from exc

                if decision is None or getattr(decision, "status", None) == "BLOCK":
                    block_code = (
                        getattr(decision, "response_key", None)
                        if decision and getattr(decision, "response_key", None)
                        else "GUARDRAIL_INPUT_INJECTION"
                    )
                    raise ContextBlockedException(
                        error_message="Historical conversation context contains unsafe content.",
                        error_code=block_code,
                    )

        return ValidatedConversationContext(
            history=history,
            summary=summary,
            total_message_count=total_message_count,
        )

    def schedule_compaction(
        self,
        session_id: str,
        client: NestJSClient,
        total_count: Optional[int] = None,
        background_tasks: Optional[set[asyncio.Task[object]] | set[asyncio.Task[None]]] = None,
        *,
        total_message_count: Optional[int] = None,
    ) -> asyncio.Task[None]:
        """Schedule asynchronous conversation compaction when sliding window overflows token budget."""
        count = (
            total_count
            if total_count is not None
            else (total_message_count if total_message_count is not None else 0)
        )
        memory_mgr = MemoryManager(
            window_size=self.window_size,
            token_budget=self.token_budget,
            gateway=self.gateway,
        )
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        summarize_task: asyncio.Task[None] = loop.create_task(
            memory_mgr.check_and_summarize(session_id, client, total_count=count + 2)
        )
        if background_tasks is not None:
            background_tasks.add(summarize_task)
            summarize_task.add_done_callback(background_tasks.discard)
        return summarize_task
