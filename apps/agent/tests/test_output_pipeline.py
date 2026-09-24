"""Public regression tests for deterministic output protection.

2026-09-06 user-approved Feature 023 migration replaced obsolete NeMo and
ChunkBuffer-internal expectations with the public deterministic boundary.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.guardrails.output_pipeline import (
    OutputGuardrailPipeline,
    payload_free_config,
)

try:
    from agent.guardrails.base import OutputGuardrailBlockedError
except ImportError:
    from agent.guardrails.output_pipeline import OutputGuardrailBlockedError


# 2026-09-06: user-approved correction of legacy deterministic-boundary tests.
def _fixture_ref(label: str, candidate: str) -> str:
    return f"{label} length={len(candidate)} fingerprint={hashlib.sha256(candidate.encode()).hexdigest()[:12]}"


def _pipeline(enabled: bool = True) -> tuple[OutputGuardrailPipeline, MagicMock]:
    secondary = MagicMock()
    secondary.validate_output_chunk = AsyncMock()
    return OutputGuardrailPipeline(SimpleNamespace(enabled=enabled), secondary), secondary


@pytest.mark.asyncio
async def test_safe_stream_is_preserved_without_secondary_model() -> None:
    pipeline, secondary = _pipeline()
    chunks = []
    for token in ("Hello ", "world. ", "Safe text."):
        chunks.extend([item async for item in pipeline.process_token(token)])
    chunks.extend([item async for item in pipeline.flush()])
    assert "".join(chunks) == "Hello world. Safe text."
    secondary.validate_output_chunk.assert_not_awaited()


@pytest.mark.asyncio
async def test_cross_token_pii_preserves_approved_prefix_only() -> None:
    pipeline, secondary = _pipeline()
    chunks = [item async for item in pipeline.process_token("Safe prefix. ")]
    with pytest.raises(OutputGuardrailBlockedError) as error:
        async for _ in pipeline.process_token("traveler@"):
            pass
        async for _ in pipeline.process_token("example.com"):
            pass
    assert "".join(chunks) == "Safe prefix. "
    assert error.value.partial_response == "Safe prefix. "
    secondary.validate_output_chunk.assert_not_awaited()


@pytest.mark.asyncio
async def test_disabled_pipeline_is_passthrough() -> None:
    pipeline, _ = _pipeline(False)
    assert [item async for item in pipeline.process_token("safe")] == ["safe"]


@pytest.mark.asyncio
async def test_overflow_fails_closed_and_cleanup_discards_pending() -> None:
    pipeline, secondary = _pipeline()
    with pytest.raises(OutputGuardrailBlockedError):
        async for _ in pipeline.process_token("x" * 8193):
            pass
    await pipeline.aclose()
    assert pipeline.buffer.raw == ""
    secondary.validate_output_chunk.assert_not_awaited()


# ---------------------------------------------------------------------------
# Feature 026 Contracts: Output Pipeline, Base Error Ownership & PII Utilities
# ---------------------------------------------------------------------------


def test_output_guardrail_blocked_error_ownership_contract() -> None:
    """Contract: OutputGuardrailBlockedError is exported by agent.guardrails.base (with transitional fallback)."""
    import agent.guardrails.base as base_mod
    import agent.guardrails.output_pipeline as pipeline_mod

    # Target owner is agent.guardrails.base; transitional owner is output_pipeline.py
    if hasattr(base_mod, "OutputGuardrailBlockedError"):
        err_cls = getattr(base_mod, "OutputGuardrailBlockedError")
        assert issubclass(err_cls, Exception)
        assert OutputGuardrailBlockedError is err_cls
    else:
        err_cls = getattr(pipeline_mod, "OutputGuardrailBlockedError")
        assert issubclass(err_cls, Exception)
        assert OutputGuardrailBlockedError is err_cls

    # Verify frozen error contract attributes
    instance = OutputGuardrailBlockedError(
        partial_response="Safe prefix.",
        layer="deterministic",
        rule="PII detection",
        message="Response was blocked for safety reasons.",
    )
    assert instance.partial_response == "Safe prefix."
    assert instance.layer == "deterministic"
    assert instance.rule == "PII detection"
    assert str(instance) == "Response was blocked for safety reasons."


def test_output_pipeline_pii_utility_migration_contract() -> None:
    """Contract: output_pipeline imports matcher, predicate, and approved_model_content from agent.guardrails.pii."""
    pii_mod = pytest.importorskip(
        "agent.guardrails.pii",
        reason="agent.guardrails.pii pending implementation in T027",
    )

    import agent.guardrails.output_pipeline as pipeline_mod

    # 1. Canonical source is pii.py
    assert hasattr(pii_mod, "deterministic_pii_match")
    assert hasattr(pii_mod, "_is_output_guardrail_disabled")
    assert hasattr(pii_mod, "approved_model_content")

    # 2. output_pipeline imports directly from pii.py
    assert getattr(pipeline_mod, "deterministic_pii_match") is getattr(
        pii_mod, "deterministic_pii_match"
    )
    assert getattr(pipeline_mod, "_is_output_guardrail_disabled") is getattr(
        pii_mod, "_is_output_guardrail_disabled"
    )
    assert getattr(pipeline_mod, "approved_model_content") is getattr(
        pii_mod, "approved_model_content"
    )

    # 3. Ensure no duplicate function definition in output_pipeline.py AST
    pipeline_source = inspect.getsource(pipeline_mod)
    tree = ast.parse(pipeline_source)
    defined_functions = [
        node.name
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    assert "deterministic_pii_match" not in defined_functions, (
        "deterministic_pii_match must be imported from agent.guardrails.pii, not defined in output_pipeline.py"
    )
    assert "_is_output_guardrail_disabled" not in defined_functions, (
        "_is_output_guardrail_disabled must be imported from agent.guardrails.pii, not defined in output_pipeline.py"
    )
    assert "approved_model_content" not in defined_functions, (
        "approved_model_content must be imported from agent.guardrails.pii, not defined in output_pipeline.py"
    )


def test_zero_duplicate_definitions_and_no_import_cycles() -> None:
    """Contract: zero duplicate definitions and zero import cycles between output_pipeline and pii."""
    pii_mod = pytest.importorskip(
        "agent.guardrails.pii",
        reason="agent.guardrails.pii pending implementation in T027",
    )

    import agent.guardrails.output_pipeline as pipeline_mod

    pii_tree = ast.parse(inspect.getsource(pii_mod))
    for node in ast.walk(pii_tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert "output_pipeline" not in alias.name, (
                    "pii.py must not import output_pipeline (would create import cycle)"
                )
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                assert "output_pipeline" not in node.module, (
                    "pii.py must not import from output_pipeline (would create import cycle)"
                )

    # Check output_pipeline does not define duplicate functions
    pipeline_tree = ast.parse(inspect.getsource(pipeline_mod))
    pipeline_defs = [
        node.name
        for node in ast.walk(pipeline_tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    ]
    assert "deterministic_pii_match" not in pipeline_defs
    assert "_is_output_guardrail_disabled" not in pipeline_defs
    assert "approved_model_content" not in pipeline_defs


def test_payload_free_config_retained_as_stateless_helper() -> None:
    """Contract: payload_free_config is retained as a stateless helper in output_pipeline.py."""
    import agent.guardrails.output_pipeline as pipeline_mod

    assert hasattr(pipeline_mod, "payload_free_config")
    assert payload_free_config is pipeline_mod.payload_free_config
    assert callable(payload_free_config)

    res_none = payload_free_config(None)
    assert res_none == {"callbacks": [], "configurable": {}}
    res_str = payload_free_config("invalid")
    assert res_str == {"callbacks": [], "configurable": {}}

    dirty_config = {
        "callbacks": ["bad_callback"],
        "messages": ["user prompt", "system prompt"],
        "input": "untrusted raw input",
        "configurable": {
            "trace_id": "tr-123",
            "user_id": "usr-456",
            "thread_id": "th-789",
            "guardrail_gateway": "mock-gateway",
            "nestjs_client": "mock-client",
            "trusted_snapshot": {"snap": 1},
            "untrusted_secret": "sk-secret-leak",
            "raw_payload": "sensitive details",
        },
    }
    clean_config = payload_free_config(dirty_config)
    assert clean_config["callbacks"] == []
    assert clean_config["configurable"] == {
        "trace_id": "tr-123",
        "user_id": "usr-456",
        "thread_id": "th-789",
        "guardrail_gateway": "mock-gateway",
        "nestjs_client": "mock-client",
        "trusted_snapshot": {"snap": 1},
    }
    assert "untrusted_secret" in dirty_config["configurable"]
    assert dirty_config["callbacks"] == ["bad_callback"]

    clean_config["configurable"]["injected"] = "bad"
    fresh_config = payload_free_config(None)
    assert fresh_config == {"callbacks": [], "configurable": {}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("shape_desc", "config"),
    [
        (
            "1. Top-level object .enabled = False",
            SimpleNamespace(enabled=False),
        ),
        (
            "2. Nested object .output_guardrail.enabled = False",
            SimpleNamespace(output_guardrail=SimpleNamespace(enabled=False)),
        ),
        (
            "3. Top-level mapping {'enabled': False}",
            {"enabled": False},
        ),
        (
            "4. Nested mapping {'output_guardrail': {'enabled': False}}",
            {"output_guardrail": {"enabled": False}},
        ),
        (
            "5a. Nested configurable {'configurable': {'output_guardrail': {'enabled': False}}}",
            {"configurable": {"output_guardrail": {"enabled": False}}},
        ),
        (
            "5b. Nested configurable {'configurable': {'enabled': False}}",
            {"configurable": {"enabled": False}},
        ),
        (
            "5c. Nested configurable with object {'configurable': {'output_guardrail': SimpleNamespace(enabled=False)}}",
            {"configurable": {"output_guardrail": SimpleNamespace(enabled=False)}},
        ),
    ],
)
async def test_streaming_disabled_behavior_across_all_five_legacy_shapes(
    shape_desc: str,
    config: Any,
) -> None:
    """Assert streaming-disabled passthrough behavior across all 5 legacy disabled-config shapes."""
    pipeline = OutputGuardrailPipeline(config)

    # 1. PII token is passed through directly without raising OutputGuardrailBlockedError
    pii_token = "bearer secret_api_token_12345"
    released_pii = [chunk async for chunk in pipeline.process_token(pii_token)]
    assert released_pii == [pii_token], f"Failed passthrough for {shape_desc}"

    # 2. Email token is passed through directly
    email_token = "traveler@example.com"
    released_email = [chunk async for chunk in pipeline.process_token(email_token)]
    assert released_email == [email_token], f"Failed passthrough for {shape_desc}"

    # 3. Buffer overflow (> 8192 bytes) is passed through without raising OutputGuardrailBlockedError
    overflow_token = "A" * 9000
    released_overflow = [chunk async for chunk in pipeline.process_token(overflow_token)]
    assert released_overflow == [overflow_token], f"Failed overflow passthrough for {shape_desc}"

    # 4. Flush is a no-op when disabled
    flushed = [chunk async for chunk in pipeline.flush()]
    assert flushed == [], f"Flush should emit nothing for {shape_desc}"
