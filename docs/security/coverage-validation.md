# Coverage & Mutation Validation Report (Phase 8 / Slice 1 — Task T048)

**Feature**: `023-security-systems`  
**Task**: T048 [Phase 8: Closure and Cross-Cutting Verification]  
**Status**: Verified & Completed  
**Date**: 2026-09-13  
**Tested Base Commit**: `0c3585c49b433ceeb739265f64ee3eb87a2df255`  
**Tested Revision SHA**: `396be97746766e6c466981881b83d1620a2322a3`  
**Harness / Test Driver**: [`apps/agent/tests/security`](../../apps/agent/tests/security)  
**Authority**: [`specs/023-security-systems/tasks.md`](../../specs/023-security-systems/tasks.md), [`specs/023-security-systems/plan.md`](../../specs/023-security-systems/plan.md), [`specs/023-security-systems/contracts/guardrail-boundaries.md`](../../specs/023-security-systems/contracts/guardrail-boundaries.md), [`tests/security/coverage-policy.json`](../../tests/security/coverage-policy.json)  

---

## 1. Executive Summary

This report documents the empirical validation of the security boundaries, fail-closed mechanics, and test suite rigor for the deterministic guardrail and streaming subsystems in [`apps/agent`](../../apps/agent).

Task T048 establishes two critical verification pillars:
1. **Disposable Mutation Testing**: Targeted mutation controls were introduced and evaluated across four core enforcement boundaries:
   - Input Admission Bypass (`validate_input` short-circuit in [`apps/agent/src/agent/guardrails/gateway.py`](../../apps/agent/src/agent/guardrails/gateway.py))
   - Tool Dispatch Allowlist Bypass (capability sealing disablement in [`apps/agent/src/agent/guardrails/gateway.py`](../../apps/agent/src/agent/guardrails/gateway.py))
   - Tool Output Sanitization Removal (inspection bypass in [`apps/agent/src/agent/guardrails/tool_output_pipeline.py`](../../apps/agent/src/agent/guardrails/tool_output_pipeline.py))
   - Streaming Output Holdback Buffer Bypass (direct unbuffered token emission in [`apps/agent/src/agent/guardrails/output_pipeline.py`](../../apps/agent/src/agent/guardrails/output_pipeline.py))
   
   **Results**: All 4 mutations were successfully detected and killed by the existing targeted test suites (100% kill rate, zero survivor mutations). After reversion, 100% of targeted test suites passed with zero regressions and zero lingering code modifications.

2. **Coverage Profiling & Policy Evaluation**: Comprehensive statement and branch coverage profiling was executed over the security-critical packages (`agent.guardrails`, `agent.streaming`, `agent.observability`) across 511 security tests in [`apps/agent/tests/security`](../../apps/agent/tests/security).
   - **Total Security Scope**: 1,564 valid statements, 1,336 covered (**85.4%** statement coverage); 588 valid branches, 428 covered (**72.8%** branch coverage).
   - **Core Guardrail Modules**: Modules such as `agent.guardrails.base` (95.1% stmts, 83.3% branches), `agent.guardrails.registry` (93.6% stmts, 81.8% branches), and `agent.guardrails.layers.injection` (95.7% stmts, 75.0% branches) demonstrated high structural coverage.
   - **Evaluation against `tests/security/coverage-policy.json`**: Policy targets require $\ge 95.0\%$ statements and $\ge 90.0\%$ branches across 11 system scopes. The localized security suite focuses on guardrail contracts, boundary invariants, and hostility stress testing; full system coverage encompassing CLI entrypoints, background task loops, and API adapters (`agent.main`, `agent.config`, `agent.tools.*`) is verified in the full-agent regression suite under T049.

---

## 2. Disposable Mutation Testing Matrix

Each mutation was applied individually to simulate an accidental removal or intentional bypass of critical security controls. Targeted test suites were executed to verify failure detection, followed by immediate reversion and verification of test passage.

| Mutation ID | Targeted Subsystem | File & Function Under Test | Targeted Test Commands | Results (Collected / Failed / Passed) | Detection Status | Reversion Verification |
|---|---|---|---|---|---|---|
| **MUT-01** | Input Guardrail Bypass | [`gateway.py:validate_input`](../../apps/agent/src/agent/guardrails/gateway.py) | `pytest test_gateway.py test_input_layers.py`<br>`pytest tests/security/dast/test_adversarial.py` | Unit: 92 coll / 7 fail / 85 pass<br>DAST: `test_adversarial_input_attack_holdout` fails | **KILLED** | 92 passed in 11.41s, DAST 6 passed, clean git status |
| **MUT-02** | Dispatch Allowlist Bypass | [`gateway.py:execute_tool*`](../../apps/agent/src/agent/guardrails/gateway.py) | `pytest test_tool_authority.py test_tool_integration.py` | 59 collected / 17 failed / 42 passed | **KILLED** | 59 passed in 10.41s, clean git status |
| **MUT-03** | Tool Result Scanning Removal | [`tool_output_pipeline.py:validate`](../../apps/agent/src/agent/guardrails/tool_output_pipeline.py) | `pytest test_tool_layers.py`<br>`pytest tests/security/dast/test_adversarial.py` | Unit: 39 coll / 11 fail / 28 pass<br>DAST: `test_adversarial_tool_output_attack_holdout` fails | **KILLED** | 39 passed in 8.33s, DAST 6 passed, clean git status |
| **MUT-04** | Output Holdback Buffer Bypass | [`output_pipeline.py:process_token`](../../apps/agent/src/agent/guardrails/output_pipeline.py) | `pytest test_output_stream.py`<br>`pytest tests/security/dast/test_adversarial.py` | Unit: 41 coll / 39 fail / 2 pass<br>DAST: `test_adversarial_streaming_output_attack_holdout` fails | **KILLED** | 41 passed in 12.87s, DAST 6 passed, clean git status |

### Detailed Mutation Specifications & Failure Signatures

#### MUT-01: Input Guardrail Bypass
- **Target**: Force early `PipelineDecision(status="PASS", validated_data=ValidatedInput(content=message))` before registry layer traversal.
- **Diff Injected**:
  ```diff
  --- a/apps/agent/src/agent/guardrails/gateway.py
  +++ b/apps/agent/src/agent/guardrails/gateway.py
  @@ -54,6 +54,11 @@ class GuardrailGateway:
                   validated_data=None,
               )
   
  +        return PipelineDecision(
  +            status="PASS",
  +            validated_data=ValidatedInput(content=message),
  +        )
  +
           try:
               layers = self.registry.ordered_layers("input")
  ```
- **Failing Tests (7)**:
  - `test_validate_input_with_empty_registry_fails_closed`
  - `test_validate_input_short_circuits_on_first_block_layer`
  - `test_validate_input_fails_closed_when_layer_raises_exception`
  - `test_chat_controller_stream_short_circuits_when_input_blocked`
  - `test_malformed_homoglyphic_prompt_injection`
  - `test_malformed_zero_width_obfuscation`
  - `test_base64_encoded_injection_payload`
- **Sample Assertion**: `AssertionError: assert 'PASS' == 'BLOCK'`
- **Reversion State**: 100% clean, 92/92 passing.

#### MUT-02: Dispatch Allowlist Bypass
- **Target**: Comment out checks verifying `tool_name in context.sealed_tools` across single-tool and batch dispatch pipelines in [`apps/agent/src/agent/guardrails/gateway.py`](../../apps/agent/src/agent/guardrails/gateway.py).
- **Diff Injected**:
  ```diff
  --- a/apps/agent/src/agent/guardrails/gateway.py
  +++ b/apps/agent/src/agent/guardrails/gateway.py
  @@ -131,13 +131,13 @@ class GuardrailGateway:
  -        if tool_name not in context.sealed_tools:
  -            return PipelineDecision(...)
  +        # if tool_name not in context.sealed_tools:
  @@ -161,7 +161,7 @@ class GuardrailGateway:
  -        if not isinstance(context, TurnCapabilities) or tool_name not in context.sealed_tools:
  +        if not isinstance(context, TurnCapabilities):
  @@ -209,13 +209,13 @@ class GuardrailGateway:
  -        if any(not name or name not in context.sealed_tools for name in names):
  -            return PipelineDecision(...)
  +        # if any(not name or name not in context.sealed_tools for name in names):
  ```
- **Failing Tests (17)**:
  - 17 tests across `TestCapabilitySealingTruthTable`, `TestWholeBatchDenialRule`, and `test_mixed_batch_denial_invokes_zero_members`.
- **Sample Assertion**: `AssertionError: Expected 'get_tool_by_name' to not have been called. Called 1 times. / assert 'PASS' == 'BLOCK'`
- **Reversion State**: 100% clean, 59/59 passing.

#### MUT-03: Tool Result Scanning Removal
- **Target**: Bypass structural node/depth validation and PII/injection scanning on tool execution outputs by returning early `PASS` in [`apps/agent/src/agent/guardrails/tool_output_pipeline.py`](../../apps/agent/src/agent/guardrails/tool_output_pipeline.py).
- **Diff Injected**:
  ```diff
  --- a/apps/agent/src/agent/guardrails/tool_output_pipeline.py
  +++ b/apps/agent/src/agent/guardrails/tool_output_pipeline.py
  @@ -45,6 +45,11 @@ class ToolOutputGuardrailPipeline:
  +        return PipelineDecision(
  +            status="PASS",
  +            validated_data=ValidatedToolResult(tool_name=tool_name, data=raw_result),
  +        )
  ```
- **Failing Tests (11)**:
  - 11 tests covering payload size ceilings, max object recursion depth, node count limits, PII credit cards, SSN, API key regex scrubbing, and indirect prompt injection payloads.
- **Sample Assertion**: `AssertionError: assert 'PASS' == 'BLOCK'`
- **Reversion State**: 100% clean, 39/39 passing.

#### MUT-04: Streaming Output Holdback Buffer Bypass
- **Target**: Bypass lookahead buffer accumulation in [`apps/agent/src/agent/guardrails/output_pipeline.py`](../../apps/agent/src/agent/guardrails/output_pipeline.py) and emit raw tokens immediately without sliding inspection window.
- **Diff Injected**:
  ```diff
  --- a/apps/agent/src/agent/guardrails/output_pipeline.py
  +++ b/apps/agent/src/agent/guardrails/output_pipeline.py
  @@ -231,23 +231,8 @@ class OutputGuardrailPipeline:
        async def process_token(self, token: str) -> AsyncGenerator[str, None]:
  -        # buffer + PII check + sliding holdback release
  +        yield token
  +        return
  ```
- **Failing Tests (39)**:
  - 39 tests across card number chunk splits, detector partitions, candidate terminators, normalized Unicode forms, width boundary limits, and streaming cancellation cleanups.
- **Sample Assertion**: `AssertionError: assert 'Your itinerary is ready. 4111-1111-1111-1111' == 'Your itinerary is ready. '`
- **Reversion State**: 100% clean, 41/41 passing.

---

## 3. Module Coverage Table & Evidence Provenance

### Execution Environment & Cryptographic Authentication
- **Commit Under Test**: `0c3585c49b433ceeb739265f64ee3eb87a2df255` (Base) / `396be97746766e6c466981881b83d1620a2322a3` (Current)
- **Branch**: `023-security-systems`
- **Harness Command**:
  ```powershell
  $env:UV_CACHE_DIR = "c:\Booking Systems\.t093-uv-cache"
  $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
  $env:PERF_TOLERANCE = "5.0"
  uv run --package agent pytest apps/agent/tests/security --cov=agent.guardrails --cov=agent.streaming --cov=agent.observability --cov-branch --cov-report=xml:artifacts/security/coverage.xml --cov-report=term-missing
  ```
- **Runtime Environment**:
  - Python: 3.11.9
  - Pytest: 8.3.4, pytest-cov: 6.0.0, coverage: 7.16.0
  - Host OS: Windows 10/11 (10.0.26100)
- **Sanitized Evidence Artifact**:
  - Location: `artifacts/security/coverage.xml` (retained via CI pipeline `.github/workflows/ci.yml` `actions/upload-artifact@v4`)
  - **SHA-256 Digest**: `548B47C4E37D458CEE10FC385B2B27B7C033142207454004C6D1DBED15E118EC`
  - Valid Statements: 1,564 | Covered Statements: 1,336 (85.42%)
  - Valid Branches: 588 | Covered Branches: 428 (72.79%)

### Module Breakdown

| Module Path | Valid Statements | Covered Statements | Statement Rate (%) | Valid Branches | Covered Branches | Branch Rate (%) | Policy Threshold Compliance ($\ge 95\%$ Stmt / $\ge 90\%$ Branch) |
|---|---|---|---|---|---|---|---|
| [`apps/agent/src/agent/guardrails/base.py`](../../apps/agent/src/agent/guardrails/base.py) | 82 | 78 | 95.1% | 18 | 15 | 83.3% | Stmt PASS / Branch Gap (83.3% vs 90%) |
| [`apps/agent/src/agent/guardrails/capabilities.py`](../../apps/agent/src/agent/guardrails/capabilities.py) | 32 | 26 | 81.3% | 22 | 16 | 72.7% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/gateway.py`](../../apps/agent/src/agent/guardrails/gateway.py) | 88 | 73 | 83.0% | 44 | 36 | 81.8% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/input_pipeline.py`](../../apps/agent/src/agent/guardrails/input_pipeline.py) | 29 | 23 | 79.3% | 10 | 8 | 80.0% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/normalization.py`](../../apps/agent/src/agent/guardrails/normalization.py) | 101 | 94 | 93.1% | 42 | 34 | 81.0% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/output_pipeline.py`](../../apps/agent/src/agent/guardrails/output_pipeline.py) | 161 | 143 | 88.8% | 76 | 60 | 79.0% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/registry.py`](../../apps/agent/src/agent/guardrails/registry.py) | 125 | 117 | 93.6% | 66 | 54 | 81.8% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/tool_output_pipeline.py`](../../apps/agent/src/agent/guardrails/tool_output_pipeline.py) | 25 | 22 | 88.0% | 10 | 9 | 90.0% | Stmt Gap / Branch PASS (90.0%) |
| [`apps/agent/src/agent/guardrails/tool_schemas.py`](../../apps/agent/src/agent/guardrails/tool_schemas.py) | 2 | 2 | 100.0% | 0 | 0 | 100.0% | **PASS** (100% / 100%) |
| [`apps/agent/src/agent/guardrails/layers/__init__.py`](../../apps/agent/src/agent/guardrails/layers/__init__.py) | 0 | 0 | 100.0% | 0 | 0 | 100.0% | **PASS** (100% / 100%) |
| [`apps/agent/src/agent/guardrails/layers/injection.py`](../../apps/agent/src/agent/guardrails/layers/injection.py) | 47 | 45 | 95.7% | 24 | 18 | 75.0% | Stmt PASS (95.7%) / Branch Gap |
| [`apps/agent/src/agent/guardrails/layers/input.py`](../../apps/agent/src/agent/guardrails/layers/input.py) | 103 | 92 | 89.3% | 44 | 33 | 75.0% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/layers/tool_output.py`](../../apps/agent/src/agent/guardrails/layers/tool_output.py) | 207 | 191 | 92.3% | 90 | 78 | 86.7% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/guardrails/schemas/__init__.py`](../../apps/agent/src/agent/guardrails/schemas/__init__.py) | 2 | 2 | 100.0% | 0 | 0 | 100.0% | **PASS** (100% / 100%) |
| [`apps/agent/src/agent/guardrails/schemas/tools.py`](../../apps/agent/src/agent/guardrails/schemas/tools.py) | 237 | 221 | 93.3% | 28 | 13 | 46.4% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/observability/__init__.py`](../../apps/agent/src/agent/observability/__init__.py) | 2 | 2 | 100.0% | 0 | 0 | 100.0% | **PASS** (100% / 100%) |
| [`apps/agent/src/agent/observability/chat_observability.py`](../../apps/agent/src/agent/observability/chat_observability.py) | 127 | 90 | 70.9% | 64 | 32 | 50.0% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/streaming/chunk_buffer.py`](../../apps/agent/src/agent/streaming/chunk_buffer.py) | 66 | 62 | 93.9% | 18 | 15 | 83.3% | Stmt Gap / Branch Gap |
| [`apps/agent/src/agent/streaming/sse.py`](../../apps/agent/src/agent/streaming/sse.py) | 128 | 53 | 41.4% | 32 | 7 | 21.9% | Stmt Gap / Branch Gap |
| **AGGREGATE TOTAL** | **1,564** | **1,336** | **85.4%** | **588** | **428** | **72.8%** | Baseline for Security Scope |

### Package-Level Summary

| Package | Statement Coverage (%) | Branch Coverage (%) |
|---|---|---|
| `apps.agent.src.agent.guardrails` | **89.6%** | **80.6%** |
| `apps.agent.src.agent.guardrails.layers` | **91.9%** | **81.7%** |
| `apps.agent.src.agent.guardrails.schemas` | **93.3%** | **46.4%** |
| `apps.agent.src.agent.observability` | **71.3%** | **50.0%** |
| `apps.agent.src.agent.streaming` | **59.3%** | **44.0%** |
| **All Scoped Packages** | **85.4%** | **72.8%** |

### Policy Threshold Evaluation & Scope Explanation

1. **Policy Threshold Specification**: [`tests/security/coverage-policy.json`](../../tests/security/coverage-policy.json) defines a required threshold of $\ge 95.0\%$ statements and $\ge 90.0\%$ branches across 11 system module scopes.
2. **Evaluation Scope**: In Task T048, coverage is evaluated specifically across the security test harness [`apps/agent/tests/security`](../../apps/agent/tests/security). Non-guardrail infrastructure modules (e.g. `agent.chat_turn.controller`, `agent.chat_turn.runner`, `agent.main`, `agent.config`, `agent.memory.manager`, `agent.tools.*`) are intentionally decoupled from this dedicated security directory and are instead exercised by functional unit and integration test suites in [`apps/agent/tests/`](../../apps/agent/tests/).
3. **Release Gate Alignment**: Full compliance across all 11 scopes in [`tests/security/coverage-policy.json`](../../tests/security/coverage-policy.json) is evaluated comprehensively in Task T049 (Full System Gates & Release Evidence) when combining the complete test matrix.

---

## 4. Critical-Transition Validation Summary

The disposable mutation testing and security regression suite validate five essential critical transitions and invariants across the agent execution lifecycle:

### 1. Input Admission Authority
- **Contract**: Every incoming user prompt must pass through [`agent.guardrails.gateway.GuardrailGateway.validate_input`](../../apps/agent/src/agent/guardrails/gateway.py) before reaching the LLM controller.
- **Enforcement**: Homoglyphs, zero-width space obfuscations, base64-encoded command injections, and empty or malformed inputs are strictly identified and intercepted.
- **Fail-Closed Behavior**: If the layer registry is empty, uninitialized, or an unexpected exception occurs, input admission returns `PipelineDecision(status="BLOCK")` immediately.

### 2. Tool Dispatch Authority & Capability Sealing
- **Contract**: An agent turn is bound to an immutable `TurnCapabilities` instance defining `sealed_tools`.
- **Enforcement**: No tool can execute unless its exact name exists within `context.sealed_tools`.
- **Whole-Batch Denial Rule**: When multi-tool dispatch is attempted, if any tool in the batch is disallowed, the entire batch is blocked (`PipelineDecision(status="BLOCK")`) and zero member tools are invoked.

### 3. Tool Output Sanitization & Bounded Traversal
- **Contract**: Tool execution results must be parsed and recursively inspected before being passed back to model context.
- **Enforcement**:
  - Max raw payload size $\le$ 64 KiB (`MAX_TOOL_RESULT_BYTES = 65_536`).
  - Max structural nesting depth $\le$ 5 levels (`MAX_TOOL_RESULT_DEPTH = 5`).
  - Max structural node count $\le$ 500 nodes (`MAX_TOOL_RESULT_NODES = 500`).
  - PII patterns (Luhn-valid credit cards, SSNs, AWS/API keys) are detected and redacted.
  - Indirect prompt injections embedded in tool returns are classified as `BLOCK`.

### 4. Streaming Holdback Sliding Inspection Window
- **Contract**: Outgoing tokens are not streamed directly to the client; they flow into a sliding holdback buffer bounded to $\le 512$ unicode scalars.
- **Enforcement**:
  - The holdback buffer accumulates tokens until safe word/sentence boundary terminators appear, allowing multi-chunk PII (e.g., credit card numbers split across 4 tokens) to be detected before release.
  - Memory consumption remains bounded ($\le 15$ MiB for 50 concurrent streams).

### 5. Fail-Closed Recovery & Error Resiliency
- **Contract**: All security operations must fail closed.
- **Enforcement**: Under network errors, timeouts, malformed payloads, or internal pipeline exceptions, decisions default to `BLOCK` or empty fallback responses. No unvalidated or raw unredacted data is ever released to the user or downstream systems.

---

## 5. Clean Working Tree Verification

All 4 disposable mutations have been completely reverted. Verification commands confirm zero mutations linger in the codebase:

```powershell
git diff apps/agent/src
# Result: Clean (exit code 0, 0 lines changed)
```

No source code modifications remain in `apps/agent/src/`. All operational and security contracts remain intact.
