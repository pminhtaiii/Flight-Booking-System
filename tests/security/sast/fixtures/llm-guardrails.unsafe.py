"""Unsafe guardrail fixture: invokes an LLM inside a guardrail validation check."""

from typing import Any
from langchain_openai import ChatOpenAI


class UnsafeModelGuardrail:
    """Guardrail layer that improperly delegates classification to an LLM."""

    def __init__(self) -> None:
        self.llm = ChatOpenAI(model="gpt-4o-mini", temperature=0.0)

    def validate_input(self, text: str) -> bool:
        # VIOLATION: Using LLM inside deterministic guardrail check
        response = self.llm.invoke(f"Is this input safe? Answer YES or NO: {text}")
        return "YES" in str(response.content).upper()

    async def validate_input_async(self, text: str) -> bool:
        # VIOLATION: Using async LLM call inside deterministic guardrail check
        response = await self.llm.ainvoke(f"Classify safety: {text}")
        return "SAFE" in str(response.content).upper()
