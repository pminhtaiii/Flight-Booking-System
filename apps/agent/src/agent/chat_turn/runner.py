"""Backward-compatible chat-turn entry point."""

from collections.abc import AsyncIterator

from agent.chat_turn.command import ChatTurnCommand
from agent.chat_turn.coordinator import (
    TurnSessionCoordinator,
    _persist_response,
    background_tasks,
)
from agent.chat_turn.events import ChatTurnEvent
from agent.guardrails.base import ValidatedInput
from agent.guardrails.gateway import OutputStreamSession
from agent.trusted_search_snapshot import TrustedSearchSnapshotLifecycle


class ChatTurnRunner(TurnSessionCoordinator):
    """Compatibility facade with the original constructor and run contract."""

    @property
    def _output_stream_session_type(self) -> type[OutputStreamSession]:
        return OutputStreamSession

    @property
    def _snapshot_lifecycle_type(self) -> type[TrustedSearchSnapshotLifecycle]:
        return TrustedSearchSnapshotLifecycle

    def run(
        self,
        command: ChatTurnCommand,
        validated_input: ValidatedInput | None = None,
    ) -> AsyncIterator[ChatTurnEvent]:
        return super().run(command, validated_input)


__all__ = [
    "ChatTurnRunner",
    "TurnSessionCoordinator",
    "_persist_response",
    "background_tasks",
]
