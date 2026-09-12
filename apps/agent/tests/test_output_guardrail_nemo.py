"""Regression coverage for the retired output NeMo classifier boundary.

2026-09-06 user-approved migration: output classification is deterministic and
must never make a secondary-model request.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.guardrails.output_pipeline import OutputGuardrailPipeline


@pytest.mark.asyncio
async def test_output_boundary_never_uses_a_secondary_model() -> None:
    secondary = MagicMock()
    secondary.validate_output_chunk = AsyncMock()
    pipeline = OutputGuardrailPipeline(SimpleNamespace(enabled=True), secondary)

    emitted = [chunk async for chunk in pipeline.process_token("A safe public response. ")]
    emitted.extend([chunk async for chunk in pipeline.flush()])

    assert "".join(emitted) == "A safe public response. "
    secondary.validate_output_chunk.assert_not_awaited()
