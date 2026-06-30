import tiktoken
import logging
from typing import List, Dict, Any, Optional
from agent.tools.nestjs_client import NestJSClient
from agent.agents.chat_agent import get_chat_model
from langchain_core.messages import SystemMessage

logger = logging.getLogger("agent.memory")

class MemoryManager:
    def __init__(self, window_size: int = 20, token_budget: int = 4000):
        self.window_size = window_size
        self.token_budget = token_budget
        try:
            self.encoding = tiktoken.get_encoding("cl100k_base")
        except Exception as e:
            logger.error(f"Failed to load tiktoken encoding: {e!s}. Falling back to default.")
            self.encoding = None

    def count_tokens(self, text: str) -> int:
        if not self.encoding:
            return len(text) // 4
        return len(self.encoding.encode(text))

    def get_older_messages_tokens(self, older_messages: List[Dict[str, Any]], summary: Optional[str]) -> int:
        tokens = 0
        if summary:
            tokens += self.count_tokens(summary)
        for msg in older_messages:
            tokens += self.count_tokens(msg.get("content", ""))
        return tokens

    async def check_and_summarize(self, session_id: str, client: NestJSClient, total_count: Optional[int] = None) -> None:
        """
        Check if the token count of older messages (messages that have slid out of the window)
        plus the existing summary exceeds the token budget. If so, trigger async summarization.
        """
        try:
            # 1. Resolve total message count from the server, even when the caller
            #    provides a hint, so concurrent writes do not truncate history.
            memory_data = await client.get_memory(session_id, recent_count=self.window_size)
            server_total = memory_data.get("totalMessageCount", 0)
            total_count = max(total_count or 0, server_total)
            
            # If total messages are within the window, no older messages exist to summarize
            if total_count <= self.window_size:
                return

            # 2. Fetch all messages in the session
            all_memory = await client.get_memory(session_id, recent_count=total_count)
            all_messages = all_memory.get("recentMessages", [])
            summary = all_memory.get("summary", None)

            # Messages that have slid out of the sliding window
            older_messages = all_messages[:-self.window_size]

            # 3. Calculate token count of older messages + summary
            older_tokens = self.get_older_messages_tokens(older_messages, summary)

            if older_tokens > self.token_budget:
                logger.info(
                    f"Token count of older messages ({older_tokens}) exceeds budget ({self.token_budget}). "
                    f"Triggering summarization for session {session_id}."
                )
                await self._generate_and_persist_summary(session_id, older_messages, summary, client)
        except Exception as e:
            logger.error(f"Failed during check_and_summarize for session {session_id}: {e!s}")
            # Fall back silently so the conversation can continue (FR-014)

    async def _generate_and_persist_summary(
        self,
        session_id: str,
        older_messages: List[Dict[str, Any]],
        existing_summary: Optional[str],
        client: NestJSClient
    ) -> None:
        # Format the older messages for the summarization prompt
        formatted_messages = []
        for msg in older_messages:
            sender = msg.get("sender", "USER")
            content = msg.get("content", "")
            formatted_messages.append(f"{sender}: {content}")
        
        history_text = "\n".join(formatted_messages)

        # Build prompt
        prompt = (
            "You are a helpful travel assistant. Your task is to update the conversation summary with the new messages that have occurred. Be concise.\n\n"
        )
        if existing_summary:
            prompt += f"Existing Summary:\n{existing_summary}\n\n"
        
        prompt += f"New Messages to incorporate:\n{history_text}\n\n"
        prompt += "Please provide a new consolidated summary of the conversation so far."

        try:
            model = get_chat_model()
            # Generate new summary using the model
            messages = [SystemMessage(content=prompt)]
            response = await model.ainvoke(messages)
            new_summary = response.content

            # Persist summary via NestJS API
            await client.create_message(
                session_id=session_id,
                sender="AGENT",
                message_type="SUMMARY",
                content=new_summary
            )
            logger.info(f"Successfully updated summary for session {session_id}.")
        except Exception as e:
            logger.error(f"Failed to generate or persist summary: {e!s}. Fallback to truncation.")
            # Do not raise the exception; fallback to truncation is handled by not saving the summary.
