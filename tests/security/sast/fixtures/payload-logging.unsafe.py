"""Unsafe logging fixture: logs raw user prompt, message, or unredacted tool payloads."""

import logging
from typing import Any, Dict

logger = logging.getLogger("agent.chat")


def process_chat_message_unsafe(prompt: str, user_input: str, unredacted_output: Dict[str, Any]) -> None:
    # VIOLATION: Logging raw user prompt
    logger.info(f"Received user prompt: {prompt}")

    # VIOLATION: Logging raw user input with debug
    logger.debug("Raw user_input received: %s", user_input)

    # VIOLATION: Logging unredacted tool payload containing sensitive data
    logger.error(f"Tool execution failed for payload: {unredacted_output}")
