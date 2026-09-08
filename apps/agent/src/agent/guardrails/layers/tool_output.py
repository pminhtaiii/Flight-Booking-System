"""Deterministic, bounded validation layers for untrusted tool results."""

import json
import re
from dataclasses import dataclass
from typing import Any, ClassVar, Literal

from pydantic import ValidationError

from agent.guardrails.base import (
    GUARDRAIL_TOOL_PII,
    GUARDRAIL_TOOL_SCHEMA,
    BaseGuardrailLayer,
    PipelineDecision,
    TurnCapabilities,
)
from agent.guardrails.layers.injection import InjectionSignatureEngine
from agent.guardrails.schemas.tools import TOOL_RESULT_SCHEMAS
from agent.sanitization.pii_scrubber import detect_pii

MAX_TOOL_RESULT_BYTES = 65_536
MAX_TOOL_RESULT_DEPTH = 5
MAX_TOOL_RESULT_NODES = 500

_SSN_PATTERN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_TOKEN_PATTERN = re.compile(
    r"(?i)\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|token)\s*[=:]\s*"
    r"(?:bearer\s+)?[a-z0-9_\-./=]{12,}"
)
_INDIRECT_DIRECTIVE_PATTERN = re.compile(
    r"(?i)(?:\[(?:system|instruction)\s*:|\bsystem\s+override\s*:|"
    r"\bignore\s+previous\s+instructions\b)"
)
_NARRATION_TOOL_NAMES = frozenset(
    {
        "search_flights",
        "get_user_preferences",
        "list_user_booking_summaries",
        "get_booking_detail",
    }
)


@dataclass(frozen=True)
class ToolOutput:
    tool_name: str
    data: Any
    raw_data: Any | None = None


def _tool_output(data: Any) -> ToolOutput | None:
    return data if isinstance(data, ToolOutput) else None


def _block_schema(reason: str) -> PipelineDecision[Any]:
    return PipelineDecision(
        status="BLOCK",
        response_key=GUARDRAIL_TOOL_SCHEMA,
        reason=reason,
        validated_data=None,
    )


def _block_pii(reason: str) -> PipelineDecision[Any]:
    return PipelineDecision(
        status="BLOCK",
        response_key=GUARDRAIL_TOOL_PII,
        reason=reason,
        validated_data=None,
    )


def _serialized_size(value: Any) -> int:
    if isinstance(value, bytes):
        return len(value)
    if isinstance(value, str):
        return len(value.encode("utf-8"))
    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8"
        )
    )


def _within_structure_limits(value: Any, max_depth: int, max_nodes: int) -> bool:
    if not isinstance(value, (dict, list)):
        return True

    stack: list[tuple[Any, int]] = [(value, 1)]
    nodes = 0
    while stack:
        current, depth = stack.pop()
        if depth > max_depth:
            return False
        if isinstance(current, dict):
            nodes += len(current)
            children = current.values()
        elif isinstance(current, list):
            nodes += len(current)
            children = current
        else:
            continue
        if nodes > max_nodes:
            return False
        for child in children:
            if isinstance(child, (dict, list)):
                stack.append((child, depth + 1))
    return True


def _string_values(value: Any) -> list[str]:
    values: list[str] = []
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            values.append(current)
        elif isinstance(current, dict):
            stack.extend(current.values())
        elif isinstance(current, (list, tuple)):
            stack.extend(current)
    return values


def _contains_sensitive_value(value: Any) -> bool:
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, str):
            if (
                detect_pii(current)
                or _SSN_PATTERN.search(current)
                or _TOKEN_PATTERN.search(current)
            ):
                return True
        elif isinstance(current, dict):
            for key, nested_value in current.items():
                if (
                    isinstance(key, str)
                    and key.lower()
                    in {"api_key", "access_token", "authorization", "bearer", "token"}
                    and isinstance(nested_value, str)
                    and len(nested_value) >= 12
                ):
                    return True
                stack.append(nested_value)
        elif isinstance(current, (list, tuple)):
            stack.extend(current)
    return False


def _contains_untrusted_directive(value: Any) -> bool:
    engine = InjectionSignatureEngine()
    for text in _string_values(value):
        detected, _ = engine.scan(text)
        if detected or _INDIRECT_DIRECTIVE_PATTERN.search(text):
            return True
    return False


def _project_search_result(raw_value: Any) -> Any:
    if not isinstance(raw_value, dict) or "flights" not in raw_value:
        return raw_value
    flights = raw_value["flights"]
    if not isinstance(flights, list):
        return raw_value
    fields = (
        "flight_id",
        "airline",
        "price",
        "origin",
        "destination",
        "date",
        "currency",
        "policy",
        "seat_available",
    )
    projected_flights = []
    for flight in flights:
        if not isinstance(flight, dict):
            return raw_value
        projected_flights.append({field: flight[field] for field in fields if field in flight})
    return {"flights": projected_flights}


def _project_registered_fields(schema: type[Any], raw_value: Any) -> Any:
    if not isinstance(raw_value, dict):
        return raw_value
    return {
        field_name: raw_value[field_name]
        for field_name in schema.model_fields
        if field_name in raw_value
    }


class SizeStructureValidator(BaseGuardrailLayer):
    key: ClassVar[str] = "tool.size_structure"
    stage: ClassVar[Literal["tool"]] = "tool"
    prerequisites: ClassVar[tuple[str, ...]] = ()

    def __init__(
        self,
        max_bytes: int = MAX_TOOL_RESULT_BYTES,
        max_depth: int = MAX_TOOL_RESULT_DEPTH,
        max_nodes: int = MAX_TOOL_RESULT_NODES,
    ) -> None:
        self.max_bytes = max_bytes
        self.max_depth = max_depth
        self.max_nodes = max_nodes

    async def check(self, context: TurnCapabilities, data: Any) -> PipelineDecision[Any]:
        value = data.data if isinstance(data, ToolOutput) else data
        try:
            if _serialized_size(value) > self.max_bytes:
                return _block_schema("Tool result exceeds the permitted size")
            if not _within_structure_limits(value, self.max_depth, self.max_nodes):
                return _block_schema("Tool result exceeds structural limits")
        except (TypeError, ValueError, UnicodeError):
            return _block_schema("Tool result could not be safely bounded")
        return PipelineDecision(status="PASS", validated_data=data)


class SchemaValidator(BaseGuardrailLayer):
    key: ClassVar[str] = "tool.schema"
    stage: ClassVar[Literal["tool"]] = "tool"
    prerequisites: ClassVar[tuple[str, ...]] = (SizeStructureValidator.key,)

    async def check(self, context: TurnCapabilities, data: Any) -> PipelineDecision[Any]:
        output = _tool_output(data)
        if output is None:
            return _block_schema("Tool result is missing its trusted tool identity")
        schema = TOOL_RESULT_SCHEMAS.get(output.tool_name)
        if schema is None:
            return _block_schema("Tool result has no registered schema")

        raw_value = output.data
        if output.tool_name in _NARRATION_TOOL_NAMES and isinstance(raw_value, str):
            raw_value = {"narration": raw_value}
        elif output.tool_name == "search_flights":
            raw_value = _project_search_result(raw_value)
        elif output.tool_name == "signal_checkout_intent" and isinstance(raw_value, str):
            try:
                raw_value = json.loads(raw_value)
            except json.JSONDecodeError:
                raw_value = {"error": raw_value}

        raw_value = _project_registered_fields(schema, raw_value)

        try:
            projected = schema.model_validate(raw_value).model_dump(exclude_none=True)
        except (ValidationError, TypeError, ValueError):
            return _block_schema("Tool result does not match its registered schema")
        return PipelineDecision(
            status="PASS",
            validated_data=ToolOutput(
                tool_name=output.tool_name,
                data=projected,
                raw_data=output.data,
            ),
        )


class PIIScanner(BaseGuardrailLayer):
    key: ClassVar[str] = "tool.pii"
    stage: ClassVar[Literal["tool"]] = "tool"
    prerequisites: ClassVar[tuple[str, ...]] = (SchemaValidator.key,)

    async def check(self, context: TurnCapabilities, data: Any) -> PipelineDecision[Any]:
        value = (
            data.raw_data
            if isinstance(data, ToolOutput) and data.raw_data is not None
            else data.data
            if isinstance(data, ToolOutput)
            else data
        )
        if _contains_sensitive_value(value):
            return _block_pii("Tool result contains sensitive data")
        return PipelineDecision(status="PASS", validated_data=data)


ToolPIIScanner = PIIScanner


class UntrustedContentInjectionDetector(BaseGuardrailLayer):
    key: ClassVar[str] = "tool.untrusted_content_injection"
    stage: ClassVar[Literal["tool"]] = "tool"
    prerequisites: ClassVar[tuple[str, ...]] = (PIIScanner.key,)

    def __init__(self, engine: InjectionSignatureEngine | None = None) -> None:
        self.engine = engine or InjectionSignatureEngine()

    async def check(self, context: TurnCapabilities, data: Any) -> PipelineDecision[Any]:
        value = data.raw_data if isinstance(data, ToolOutput) else data
        for text in _string_values(value):
            detected, _ = self.engine.scan(text)
            if detected or _INDIRECT_DIRECTIVE_PATTERN.search(text):
                return _block_schema("Tool result contains an untrusted instruction")
        return PipelineDecision(status="PASS", validated_data=data)


__all__ = [
    "MAX_TOOL_RESULT_BYTES",
    "MAX_TOOL_RESULT_DEPTH",
    "MAX_TOOL_RESULT_NODES",
    "ToolOutput",
    "SizeStructureValidator",
    "SchemaValidator",
    "PIIScanner",
    "ToolPIIScanner",
    "UntrustedContentInjectionDetector",
]
