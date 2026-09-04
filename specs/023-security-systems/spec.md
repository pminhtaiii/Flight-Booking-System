# Specification: Deterministic Guardrails and Security Verification

**Feature**: 023-security-systems | **Date**: 2026-09-04 | **Status**: Planning baseline

Derived from the user's requested penetration/security implementation plan and the September 4 guardrail ADR. Research is design evidence, not authorization to run attacks or modify production. This supplies the missing Spec Kit specification prerequisite.

## User Stories

### US1 — Protect every chat turn (P1)
As a traveler, I receive safe, deterministic guardrail responses through one boundary.
- SSE and internal controller calls reject malicious input before router/model/tool execution.
- Missing gateway/configuration fails closed; benign flight requests and general greetings pass without a secondary guardrail LLM call.
- Synthetic protected values split across chunks never reach unauthorized SSE, assistant persistence or logs; output blocks stop streaming safely.
- Disconnect/cancellation retains existing fenced cleanup semantics.

### US2 — Constrain tools and results (P1)
As a traveler, model-generated calls cannot exceed turn capabilities or expose another user's data.
- GENERAL has zero tools; SEARCH/BOOKING_INQUIRY use travel tools; CHECKOUT uses the advisory signal tool. Malformed/unknown routing denies tools; trusted low-confidence, checkout-downgrade and single-agent cases follow the explicit capability table. Seal capabilities after routing/gates and forbid later expansion.
- Forged or mixed unauthorized tool batches cause zero invocations.
- Every result is validated/minimized/scanned before graph state, signal parsing, checkpointing, model context or public events.
- Existing auth, ownership, snapshot, attestation and deterministic transaction boundaries remain intact.

### US3 — Detect unsafe code before merge (P1)
As a maintainer, I receive reproducible SAST, SCA and secret checks enforced by CI.
- Vulnerable fixture controls trigger findings; equivalent safe controls do not.
- Missing reports, unexpected empty scope, scanner errors, expired exceptions and applicable skipped jobs fail `ci-status`.

### US4 — Prove runtime attack resistance (P1)
As a reviewer, I can reproduce attacks against an isolated full stack.
- At least 200 malicious and 500 benign stage-delivered detector holdout cases (input 100/250, tool 50/125, output 50/125), separate from invariant cases, achieve TPR >=95% and FPR <=2%, aggregate and per pipeline stage.
- Authenticated and unauthenticated conventional DAST plus SSE/tool tests verify ownership, privacy and side effects with two synthetic users.
- HTTP errors or model refusal alone are not success: inspect calls, stores, events and telemetry.

### US5 — Operate and release safely (P2)
As an operator, I can observe security decisions and roll back without bypassing protection.
- Events contain no raw prompts, results, credentials or user IDs; metrics have bounded labels.
- Adversarial near-limit payloads satisfy measured resource budgets.
- Evidence and rollback rehearsals are complete; rollback may disable chat but cannot expose unguarded execution.

## Requirements

- FR-001: Thin ChatController; runner owns input/tool/output invocation of mandatory GuardrailGateway.
- FR-002: Ten layers, closed registry, validated ordering, compulsory production layers; no arbitrary configuration imports.
- FR-003: NFKC/control handling and bounded Base64/hex/URL inspection; >=50 reviewed injection signatures.
- FR-004: Deterministic length, PII, topic, tool structure/schema and streaming checks; no security LLM judge or generated refusal.
- FR-005: Dispatch allowlisting, strict projections, existing server identity/ownership/attestation guarantees.
- FR-006: Preserve SSE schemas, approved-prefix persistence, fencing and cleanup; dedicated trusted action metadata stays separate from narration.
- FR-007: Layer, boundary, SAST, SCA, secrets, conventional DAST and adversarial tests.
- FR-008: Versioned thresholds, complete evidence and fail-closed CI; bounded exceptions.
- FR-009: Payload-free structured audit, metrics/dashboard, performance and rollback tests.

## Success Criteria

- SC-001: Every layer/entry point has pass/block/boundary/error assertions. Changed security modules >=95% statement and >=90% branch coverage; explicit critical-transition assertions.
- SC-002: TPR >=95%, FPR <=2%; zero unauthorized dispatch, cross-user access, PII/credential escape or model-driven booking/payment mutations in invariant cases.
- SC-003: Zero unresolved Critical/High findings at release. Scanner/harness execution failures block.
- SC-004: Zero extra guardrail model calls. Provisional p95 goals: <=1 ms per typical layer, <=10 ms aggregate guardrail compute per typical turn, <=50 ms per near-limit check on recorded hardware; buffering wait reported separately.

## Scope

Current delivery is documents only. Future tasks implement guardrails and local penetration infrastructure. Production probes, live-model campaigns, new WebSocket/batch endpoints, neural judges, general toxicity classifiers and new per-session tool budgets are deferred. Existing quotas remain. Parser safety bounds are in scope; see research decisions.

## Review Clarifications

The detailed boundary contract defines finite supported PII formats and lookaround/normalization bounds, generated-summary checks, model callback restrictions and stage-local score oracles. Admission and tool-authority sealing are separate lifecycle steps. Evaluation quotas are isolated test configuration; actual default quotas are verified in a separate invariant profile. All six cycle-1 corrections remain within the original guardrail/security verification scope.
