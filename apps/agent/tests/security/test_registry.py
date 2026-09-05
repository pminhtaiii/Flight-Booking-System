from pathlib import Path
from typing import ClassVar, Literal

import pytest

from agent.guardrails.base import AdmissionContext, PipelineDecision, ValidatedInput

registry_module = pytest.importorskip(
    "agent.guardrails.registry",
    reason="T013 supplies the closed registry implementation",
)
GuardrailRegistry = registry_module.GuardrailRegistry
RegistryContractError = registry_module.RegistryContractError
create_production_registry = registry_module.create_production_registry

pytestmark = pytest.mark.security


class StubLayer:
    key: ClassVar[str] = "input.stub"
    stage: ClassVar[Literal["input"]] = "input"
    prerequisites: ClassVar[tuple[str, ...]] = ()

    async def check(
        self, context: AdmissionContext, data: str
    ) -> PipelineDecision[ValidatedInput]:
        return PipelineDecision(status="PASS", validated_data=ValidatedInput(content=data))


class DependentStubLayer(StubLayer):
    key = "input.dependent"
    prerequisites = (StubLayer.key,)


class CycleA(StubLayer):
    key = "input.cycle_a"
    prerequisites = ("input.cycle_b",)


class CycleB(StubLayer):
    key = "input.cycle_b"
    prerequisites = (CycleA.key,)


def test_unknown_layer_keys_fail_closed_on_registration_and_lookup() -> None:
    registry = GuardrailRegistry(allowed_keys={StubLayer.key}, production=False)

    with pytest.raises(RegistryContractError):
        registry.register(DependentStubLayer())
    with pytest.raises(RegistryContractError):
        registry.get("input.unknown")


def test_duplicate_layer_keys_are_rejected() -> None:
    registry = GuardrailRegistry(allowed_keys={StubLayer.key}, production=False)
    registry.register(StubLayer())

    with pytest.raises(RegistryContractError):
        registry.register(StubLayer())


def test_registry_source_contains_no_dynamic_import_execution() -> None:
    registry_source = (
        Path(__file__).parents[2] / "src" / "agent" / "guardrails" / "registry.py"
    ).read_text(encoding="utf-8")

    forbidden = ("__import__(", "importlib.import_module", "eval(", "exec(")
    assert all(token not in registry_source for token in forbidden)


def test_compulsory_production_layers_cannot_be_omitted_or_disabled() -> None:
    with pytest.raises(RegistryContractError):
        create_production_registry(disabled_keys={"input.injection"})

    registry = create_production_registry()
    assert {"input.length", "input.pii", "input.injection"}.issubset(registry.keys())


def test_layers_are_returned_in_topological_prerequisite_order() -> None:
    registry = GuardrailRegistry(
        allowed_keys={StubLayer.key, DependentStubLayer.key}, production=False
    )
    registry.register(DependentStubLayer())
    registry.register(StubLayer())

    assert [layer.key for layer in registry.ordered_layers("input")] == [
        StubLayer.key,
        DependentStubLayer.key,
    ]


def test_missing_prerequisite_fails_closed() -> None:
    registry = GuardrailRegistry(
        allowed_keys={StubLayer.key, DependentStubLayer.key}, production=False
    )
    registry.register(DependentStubLayer())

    with pytest.raises(RegistryContractError):
        registry.ordered_layers("input")


def test_cyclic_prerequisites_fail_closed() -> None:
    registry = GuardrailRegistry(
        allowed_keys={CycleA.key, CycleB.key}, production=False
    )
    registry.register(CycleA())
    registry.register(CycleB())

    with pytest.raises(RegistryContractError):
        registry.ordered_layers("input")


def test_test_injection_is_instance_local_and_forbidden_in_production() -> None:
    test_registry = GuardrailRegistry(allowed_keys={StubLayer.key}, production=False)
    second_registry = GuardrailRegistry(allowed_keys={StubLayer.key}, production=False)
    production_registry = GuardrailRegistry(allowed_keys={StubLayer.key}, production=True)

    test_registry.inject_for_test(StubLayer())

    assert test_registry.get(StubLayer.key).key == StubLayer.key
    with pytest.raises(RegistryContractError):
        second_registry.get(StubLayer.key)
    with pytest.raises(RegistryContractError):
        production_registry.inject_for_test(StubLayer())
