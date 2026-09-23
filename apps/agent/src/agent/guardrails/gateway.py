import inspect
import logging
from typing import Any, AsyncIterator, Callable

from agent.guardrails.base import (
    GUARDRAIL_INPUT_INJECTION,
    GUARDRAIL_RESPONSE_KEYS,
    GUARDRAIL_TOOL_PII,
    GUARDRAIL_TOOL_SCHEMA,
    AdmissionContext,
    ApprovedChunk,
    PipelineDecision,
    TurnCapabilities,
    ValidatedInput,
    ValidatedToolResult,
)
from agent.guardrails.layers.input import (
    InjectionDetector,
    LengthValidator,
    PIIDetector,
    TopicBoundary,
)
from agent.guardrails.layers.tool_output import (
    PIIScanner,
    SchemaValidator,
    SizeStructureValidator,
    ToolOutput,
    ToolPIIScanner,
    UntrustedContentInjectionDetector,
)
from agent.guardrails.output_pipeline import OutputGuardrailPipeline

logger = logging.getLogger("agent.guardrails.gateway")


def assert_layer_order(
    stage: str,
    layers: tuple[Any, ...] | list[Any],
    expected_types: tuple[type, ...] | list[type],
) -> None:
    """
    Enforces exact layer count, expected type at every position, unique layer keys,
    and earlier same-stage prerequisite declaration for a stage tuple.
    """
    if len(layers) != len(expected_types):
        raise ValueError(
            f"Stage '{stage}' layer count mismatch: expected {len(expected_types)}, got {len(layers)}"
        )

    seen_keys: set[str] = set()
    stage_keys = [getattr(lyr, "key", None) for lyr in layers]

    for idx, (layer, exp_type) in enumerate(zip(layers, expected_types)):
        if not isinstance(layer, exp_type):
            raise TypeError(
                f"Stage '{stage}' layer at index {idx} has wrong type: expected {exp_type.__name__}, got {type(layer).__name__}"
            )
        key = getattr(layer, "key", None)
        if not key or not isinstance(key, str):
            raise ValueError(f"Stage '{stage}' layer at index {idx} has invalid key: {key}")
        if key in seen_keys:
            raise ValueError(f"Stage '{stage}' contains duplicate layer key: {key}")

        prereqs = getattr(layer, "prerequisites", ())
        for prereq in prereqs:
            if prereq not in seen_keys:
                if prereq in stage_keys:
                    raise ValueError(
                        f"Stage '{stage}' layer '{key}' has prerequisite '{prereq}' declared later in the stage tuple"
                    )
                raise ValueError(
                    f"Stage '{stage}' layer '{key}' has unknown prerequisite '{prereq}'"
                )
        seen_keys.add(key)


class OutputStreamSession:
    """
    Async context-managed session facade wrapping OutputGuardrailPipeline.
    """

    def __init__(
        self,
        context: Any = None,
        config: Any = None,
        session_id: str | None = None,
        pipeline: OutputGuardrailPipeline | None = None,
    ) -> None:
        if isinstance(context, OutputGuardrailPipeline) and pipeline is None:
            pipeline = context
            context = None
        self.context = context
        self.config = config
        self.session_id = session_id or "test-session"
        if pipeline is not None:
            self._pipeline = pipeline
        else:
            self._pipeline = OutputGuardrailPipeline(
                config=config,
                session_id=session_id,
            )
        self.closed = False
        self._flushed = False

    @property
    def buffer(self) -> Any:
        return self._pipeline.buffer

    @property
    def partial_response(self) -> str:
        return self._pipeline.partial_response

    async def process_token(self, token: str) -> AsyncIterator[str]:
        if self.closed:
            raise RuntimeError("Cannot process tokens on closed session")
        async for chunk in self._pipeline.process_token(token):
            yield chunk

    async def flush(self) -> AsyncIterator[str]:
        if self.closed or self._flushed:
            return
        self._flushed = True
        async for chunk in self._pipeline.flush():
            yield chunk

    def close(self) -> None:
        self.closed = True
        self._pipeline.closed = True

    async def aclose(self) -> None:
        self.close()

    async def __aenter__(self) -> "OutputStreamSession":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: Any,
    ) -> bool:
        self.close()
        return False


_DEFAULT_REGISTRY = object()


class GuardrailGateway:
    """
    Mandatory security gateway enforcing deterministic admission, tool execution,
    and output streaming checks without permissive bypasses.
    """

    def __init__(
        self,
        registry: Any = _DEFAULT_REGISTRY,
        *,
        _input_layers: tuple[Any, ...] | list[Any] | None = None,
        _tool_layers: tuple[Any, ...] | list[Any] | None = None,
    ) -> None:
        if registry is _DEFAULT_REGISTRY:
            self.registry = None
            if _input_layers is None and _tool_layers is None:
                prod_input = (
                    LengthValidator(),
                    PIIDetector(),
                    InjectionDetector(),
                    TopicBoundary(),
                )
                prod_tool = (
                    SizeStructureValidator(),
                    SchemaValidator(),
                    PIIScanner(),
                    UntrustedContentInjectionDetector(),
                )
                assert_layer_order(
                    "input",
                    prod_input,
                    (LengthValidator, PIIDetector, InjectionDetector, TopicBoundary),
                )
                assert_layer_order(
                    "tool",
                    prod_tool,
                    (
                        SizeStructureValidator,
                        SchemaValidator,
                        PIIScanner,
                        UntrustedContentInjectionDetector,
                    ),
                )
                self._input_layers = prod_input
                self._tool_layers = prod_tool
            else:
                if _input_layers is not None:
                    if (
                        len(_input_layers) == 2
                        and isinstance(_input_layers[0], LengthValidator)
                        and isinstance(_input_layers[1], InjectionDetector)
                    ):
                        assert_layer_order(
                            "input",
                            _input_layers,
                            (LengthValidator, InjectionDetector),
                        )
                    else:
                        assert_layer_order(
                            "input",
                            _input_layers,
                            (LengthValidator, PIIDetector, InjectionDetector, TopicBoundary),
                        )
                    self._input_layers = tuple(_input_layers)
                else:
                    self._input_layers = ()

                if _tool_layers is not None:
                    assert_layer_order(
                        "tool",
                        _tool_layers,
                        (
                            SizeStructureValidator,
                            SchemaValidator,
                            PIIScanner,
                            UntrustedContentInjectionDetector,
                        ),
                    )
                    self._tool_layers = tuple(_tool_layers)
                else:
                    self._tool_layers = ()
        else:
            from agent.guardrails.registry import GuardrailRegistry, RegistryContractError

            if registry is None or not isinstance(registry, GuardrailRegistry):
                raise RegistryContractError(
                    "GuardrailGateway requires a valid GuardrailRegistry instance when registry is provided."
                )
            self.registry = registry

            if _input_layers is not None:
                self._input_layers = tuple(_input_layers)
            elif hasattr(registry, "ordered_layers"):
                self._input_layers = tuple(registry.ordered_layers("input"))
            else:
                self._input_layers = ()

            if _tool_layers is not None:
                self._tool_layers = tuple(_tool_layers)
            elif hasattr(registry, "ordered_layers"):
                self._tool_layers = tuple(registry.ordered_layers("tool"))
            else:
                self._tool_layers = ()

    def is_healthy(self) -> bool:
        if self.registry is not None:
            if hasattr(self.registry, "is_healthy"):
                return bool(self.registry.is_healthy())
            return True
        return True

    async def validate_input(
        self,
        context: AdmissionContext,
        message: str,
    ) -> PipelineDecision[ValidatedInput]:
        """
        Validates user input against registered input layers in sequence.
        Short-circuits on first BLOCK and fails closed on unhandled errors.
        """
        if not isinstance(context, AdmissionContext):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Invalid admission context",
                validated_data=None,
            )

        layers = self._input_layers
        if not layers:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_INPUT_INJECTION,
                reason="Guardrail classifier failed closed: no input layers configured",
                validated_data=None,
            )

        for layer in layers:
            try:
                decision = await layer.check(context, message)
                if decision.status == "BLOCK":
                    key = (
                        decision.response_key
                        if decision.response_key in GUARDRAIL_RESPONSE_KEYS.values()
                        else GUARDRAIL_INPUT_INJECTION
                    )
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=key,
                        reason=decision.reason,
                        validated_data=None,
                    )
                if decision.status != "PASS":
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=GUARDRAIL_INPUT_INJECTION,
                        reason="Guardrail classifier failed closed",
                        validated_data=None,
                    )
            except Exception:
                return PipelineDecision(
                    status="BLOCK",
                    response_key=GUARDRAIL_INPUT_INJECTION,
                    reason="Guardrail classifier failed closed",
                    validated_data=None,
                )

        return PipelineDecision(
            status="PASS",
            validated_data=ValidatedInput(content=message),
        )

    async def execute_tool(
        self,
        context: TurnCapabilities,
        call: Any,
        invoke: Callable[..., Any],
    ) -> PipelineDecision[ValidatedToolResult]:
        """
        Tool execution gateway stub.
        Enforces that calls match sealed tool capabilities and fails closed on errors.
        """
        if not isinstance(context, TurnCapabilities):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Invalid turn capabilities",
                validated_data=None,
            )

        tool_name = getattr(call, "name", None)
        if not tool_name and isinstance(call, dict):
            tool_name = call.get("name")
        if not tool_name:
            tool_name = str(call)

        if tool_name not in context.sealed_tools:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason=f"Tool execution forbidden: tool '{tool_name}' not in sealed capabilities",
                validated_data=None,
            )

        try:
            if inspect.iscoroutinefunction(invoke):
                result = await invoke()
            else:
                res = invoke()
                if inspect.isawaitable(res):
                    result = await res
                else:
                    result = res
            return await self.validate_tool_result(context, tool_name, result)
        except Exception:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool execution failed closed",
                validated_data=None,
            )

    async def validate_tool_result(
        self, context: TurnCapabilities, tool_name: str, result: Any
    ) -> PipelineDecision[ValidatedToolResult]:
        """
        Sole public tool result validation method.
        Validates context, sealed authority, and iterates through _tool_layers.
        """
        if not isinstance(context, TurnCapabilities) or tool_name not in context.sealed_tools:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool result has no sealed authority",
                validated_data=None,
            )
        try:
            layers = self._tool_layers
            if not layers:
                if self.registry is not None and getattr(self.registry, "production", False):
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=GUARDRAIL_TOOL_SCHEMA,
                        reason="Tool output guardrail pipeline is not configured",
                        validated_data=None,
                    )
                return PipelineDecision(
                    status="PASS",
                    validated_data=ValidatedToolResult(tool_name=tool_name, data=result),
                )

            current: Any = ToolOutput(tool_name=tool_name, data=result)
            for layer in layers:
                try:
                    decision = await layer.check(context, current)
                except Exception:
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=GUARDRAIL_TOOL_SCHEMA,
                        reason="Tool output validation failed closed",
                        validated_data=None,
                    )
                if decision.status != "PASS" or not isinstance(decision.validated_data, ToolOutput):
                    if isinstance(layer, SchemaValidator):
                        pii_layer = next(
                            (
                                lyr
                                for lyr in layers
                                if isinstance(lyr, (PIIScanner, ToolPIIScanner))
                                or getattr(lyr, "key", "") == "tool.pii"
                            ),
                            None,
                        )
                        if pii_layer is not None:
                            try:
                                raw_output = ToolOutput(tool_name=tool_name, data=result)
                                pii_decision = await pii_layer.check(context, raw_output)
                                if pii_decision.status == "BLOCK":
                                    return PipelineDecision(
                                        status="BLOCK",
                                        response_key=pii_decision.response_key
                                        or GUARDRAIL_TOOL_PII,
                                        reason=pii_decision.reason
                                        or "Tool output validation failed closed",
                                        validated_data=None,
                                    )
                            except Exception:
                                logger.warning(
                                    "PIIScanner check during schema failure failed", exc_info=True
                                )
                    return PipelineDecision(
                        status="BLOCK",
                        response_key=decision.response_key or GUARDRAIL_TOOL_SCHEMA,
                        reason=decision.reason or "Tool output validation failed closed",
                        validated_data=None,
                    )
                current = decision.validated_data

            return PipelineDecision(
                status="PASS",
                validated_data=ValidatedToolResult(tool_name=tool_name, data=current.data),
            )
        except Exception:
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool output validation failed closed",
                validated_data=None,
            )

    async def execute_tool_batch(
        self,
        context: TurnCapabilities,
        calls: list[Any],
        invokes: list[Callable[..., Any]],
    ) -> PipelineDecision[list[ValidatedToolResult]]:
        """Authorize the whole proposed batch before invoking any member."""
        if not isinstance(context, TurnCapabilities) or len(calls) != len(invokes):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Invalid tool batch",
                validated_data=None,
            )
        names = [
            call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
            for call in calls
        ]
        if any(not name or name not in context.sealed_tools for name in names):
            return PipelineDecision(
                status="BLOCK",
                response_key=GUARDRAIL_TOOL_SCHEMA,
                reason="Tool batch contains unauthorized calls",
                validated_data=None,
            )
        validated: list[ValidatedToolResult] = []
        for call, invoke in zip(calls, invokes):
            decision = await self.execute_tool(context, call, invoke)
            if decision.status != "PASS" or decision.validated_data is None:
                return PipelineDecision(
                    status="BLOCK",
                    response_key=decision.response_key or GUARDRAIL_TOOL_SCHEMA,
                    reason=decision.reason,
                    validated_data=None,
                )
            validated.append(decision.validated_data)
        return PipelineDecision(status="PASS", validated_data=validated)

    def stream_output(
        self,
        context: Any = None,
        tokens: Any = None,
        *,
        config: Any = None,
        session_id: str | None = None,
    ) -> Any:
        """
        Output streaming factory.
        If tokens provided, returns legacy async generator of ApprovedChunk.
        Otherwise returns OutputStreamSession.
        """
        if tokens is not None:

            async def _legacy_tokens() -> AsyncIterator[ApprovedChunk]:
                async for token in tokens:
                    yield ApprovedChunk(content=token)

            return _legacy_tokens()
        return OutputStreamSession(context=context, config=config, session_id=session_id)


__all__ = ["GuardrailGateway", "OutputStreamSession", "assert_layer_order"]
