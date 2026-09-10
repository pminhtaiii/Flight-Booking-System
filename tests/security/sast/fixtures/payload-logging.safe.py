"""Safe logging fixture: logs only payload-free metadata and identifiers."""

import logging
from typing import Any, Dict

logger = logging.getLogger("agent.security")


def process_chat_message_safe(turn_id: str, token_count: int, duration_ms: float) -> None:
    # Compliant: Log only status, event names, counts, duration metadata
    logger.info(
        "Chat turn completed",
        extra={
            "event": "chat_turn_completed",
            "status": "SUCCESS",
            "turn_id": turn_id,
            "token_count": token_count,
            "duration_ms": duration_ms,
        },
    )
