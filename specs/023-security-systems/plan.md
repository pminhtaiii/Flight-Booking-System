# Implementation and Penetration Plan: Security Systems

**Branch**: `023-security-systems` | **Date**: 2026-09-04 | **Spec**: [spec.md](spec.md)
**Status**: Planned. No implementation or scanner results claimed.

## Summary

Implement the ten deterministic layers in the September 4 guardrail ADR through one mandatory gateway. Preserve authentication, Redis fencing, encrypted chat persistence and deterministic checkout. Prove enforcement with unit/integration tests, SAST, dependency/secret checks, conventional web/API DAST and a separate SSE/tool adversarial suite. `tasks.md` is the canonical phased checklist requested by the user.

## Technical Context

- **Language/version**: Python >=3.11, TypeScript, existing Node 20 CI. Resolve exact application versions from `uv.lock` and `pnpm-lock.yaml`; no stack upgrade required.
- **Dependencies**: Existing FastAPI, Pydantic v2, LangGraph/LangChain, Redis, NestJS, Next.js and Prisma. Proposed test tools: pinned Semgrep rules/CLI, OWASP ZAP, pytest-cov, existing pytest/Jest/Playwright. Dependency and secret scanner selection is bounded by T003.
- **Storage**: Existing PostgreSQL encrypted chat and Redis fencing/snapshots. No new application database; sanitized CI evidence.
- **Testing**: Layer/partition tests, boundary contracts, local full-stack DAST, held-out attack corpus, scanner fixture tests and CI contract tests.
- **Platform/type**: Existing web/API/agent monorepo; Linux CI containers and Windows PowerShell local orchestration.
- **Performance goals**: Provisional <=1 ms p95 per layer on typical fixtures, <=10 ms p95 total guardrail compute per typical turn, <=50 ms p95 per near-limit check on a documented runner. Measure buffering wait separately. These are targets, not established results.
- **Constraints**: No secondary security-model calls; no supplier/payment traffic in adversarial CI; no PII in logs/reports; one required `ci-status`; compulsory production layers.
- **Scope**: Ten layers, three lifecycle enforcement points, six existing tools, direct SSE and internal controller. New transport endpoints deferred.

## Constitution Check

| Principle | Pre-design and post-design evaluation |
|---|---|
| Flight first | PASS by design: no extra transaction steps or non-flight product scope |
| Deterministic transaction boundary | PASS by design: test zero unauthorized side effects; retain trusted checkout |
| API budget discipline | PASS by design: local provider stubs and existing quotas; no new external critical-path call |
| Observability | PASS by design: structured payload-free events and bounded metric labels |
| Incremental delivery | PASS by design: per-story gates and fail-closed rollback |
| Data protection | PASS by design: synthetic corpus, safe persistence and restricted audit pseudonyms |

These are design checks, not a claim that current code passes them. No constitutional exception requested.

## Project Structure

```text
specs/023-security-systems/
  spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
  security-test-matrix.md
  contracts/guardrail-boundaries.md
apps/agent/src/agent/
  chat_turn/controller.py                      # new
  chat_turn/runner.py                          # existing lifecycle owner
  guardrails/gateway.py, registry.py           # new
  guardrails/input_pipeline.py                # new
  guardrails/tool_output_pipeline.py          # new
  guardrails/layers/, schemas/                 # new
  guardrails/output_pipeline.py               # existing, remove neural checks
  graph/nodes.py                              # guard dispatch before state updates
  observability/security_events.py            # new
apps/agent/tests/security/                    # new boundary/layer tests
scripts/security/                            # new test/scan/report tooling
tests/security/{corpus,sast,zap,dast}/        # new harness inputs
.github/workflows/ci.yml                      # existing aggregate gate
scripts/ci/evaluate-ci-status.mjs             # existing aggregate evaluator
```

New paths are planned. Reuse `streaming/chunk_buffer.py`, `sanitization/pii_scrubber.py`, existing tool projections, repositories and telemetry infrastructure when their contracts fit. No SessionManager, HistoryLogger or parallel persistence system.

## Architecture and Enforcement Order

1. SSE retains HTTP authentication/admission, request decoding and event serialization. Zero guardrail policy in transports does not mean removing authentication. A thin ChatController delegates a command to ChatTurnRunner. Test an in-process adapter without shipping WebSocket/batch endpoints.
2. Runner requires a gateway and checks input before graph/router/model execution and raw rejected-message persistence. Treat loaded conversation history and summaries as untrusted: validate before any summarizer/router/model call, rejecting/quarantining unsafe entries. Registry configuration is immutable; buffers belong to one turn. Tool capabilities are sealed only after routing and deterministic gate evaluation; see the capability table in `contracts/guardrail-boundaries.md`. Enforce raw ASGI request-byte limits before FastAPI JSON parsing and streamed upstream tool-response limits before JSON loading; Content-Length alone is not trusted, and decompressed bytes are bounded too.
3. Runner supplies a compulsory turn-scoped guarded executor to the graph. Check the entire requested tool batch against the effective allowlist before any invocation. Validate/minimize results before creating publishable ToolMessages, updating graph/checkpoint state, parsing checkout signals, or invoking model continuation. Observing `on_tool_end` in runner is too late. Ensure raw results do not escape via tracing callbacks.
4. Retain private attestation/snapshot state and explicit public projections. Narrative scanning must not destroy the legitimate dedicated ACTION_HANDOFF token channel. Auth, ownership, freshness and commitment checks remain independent of model intent.
5. Output validation must withhold undecided suffixes BEFORE publication. Look-back scanning cannot recall emitted text. Use the versioned detector-width/512-scalar lookaround and raw-mapping policy in `contracts/guardrail-boundaries.md`; reject overlong candidates and pending buffers above 8 KiB before release. Test every character split, arbitrary token partitions, EOF, punctuation, long unbroken streams and cross-turn isolation.
6. Blocks use static copy. Output violations stop upstream, discard pending text and persist only the approved prefix. Preserve existing runner cleanup ordering and deadlines; never reveal payloads, signatures or raw exceptions.

## Phase Plan

| Phase | Delivery | Exit evidence |
|---|---|---|
| 0: Research/design (this run) | Specification, decisions, interfaces, matrix | No blocking design placeholders |
| 1: Setup | Inventory, pins, baseline fixtures | Every entry point/tool/sink mapped |
| 2: Foundation | Corpus/report contracts, isolation harness, common types | Success, violation, missing-report and infrastructure cases distinguished |
| 3: US1 | Gateway, controller, input/output protection | Input bypass and output split tests pass; no judge calls |
| 4: US2 | Tool dispatch and four tool-output layers | Zero unauthorized calls or unvalidated exposure |
| 5: US3 | SAST/SCA/secrets and CI integration | Unsafe/safe controls pass; errors propagate to ci-status |
| 6: US4 | Authenticated HTTP and SSE/tool DAST | Coverage complete, detection rates and invariants pass |
| 7: US5 | Telemetry, performance and release controls | Safe events, measured budgets, rollback rehearsal |
| 8: Closure | Retest findings and publish evidence | All applicable regression/security gates pass with exit codes |

US1 is the smallest integration MVP, behind disabled public chat exposure until US2 is safe. Production security release requires all stories and closure. SAST can progress alongside runtime work after foundation. Full DAST acceptance depends on US1/US2.

## Penetration Test Execution Design

**Scope/environment**: disposable local PostgreSQL/Redis namespaces; two synthetic users; real API/agent/web processes; local model/supplier protocol stubs. No production or third-party targets. Validate a fixed local/container host and resolved-address allowlist, including redirects. Run limits: 30 minutes, concurrency 2, 5 requests/sec, 5,000 requests; SSE max 30 seconds/turn. Stop on out-of-scope resolution or non-test data. These controls become harness configuration, not informal operator advice.

**Discovery**: generate endpoint/method inventory from actual routing/OpenAPI plus explicit SSE events. Classify public, user-authenticated, owner-only and service-only surfaces. Count exercised endpoints and authenticated successes. Repeated 401s or zero protected routes are incomplete coverage.

**Sequence**: unauthenticated baseline -> verified authenticated ZAP API/browser scan -> two-user ownership/replay/session attacks -> HTTP/SSE payload replay -> malicious tool-result stubs -> output/state/log leakage probes -> bounded resource tests -> finding retests with benign neighbors.

**Oracles**: inspect client bytes/events, backend invocation counters, decrypted synthetic test records, Redis state, model request capture and log capture. Input blocks mean zero router/model/tool calls. Tool blocks mean no forbidden values in next-model requests, graph/checkpoints, signals, SSE, assistant persistence or logs. Legitimately encrypted approved user messages are distinguished from telemetry leaks. Refusal text or HTTP failure alone is not mitigation evidence.

**Corpus**: at least 200 unique malicious holdout cases and 500 benign holdout cases, separate from tuning data. Include role overrides, multi-turn history, Unicode/zero-width/control tokens, multilingual/encoded injection, indirect tool instructions, forged tool calls/signals, output PII partitions and bounded resource abuse. Include benign prices/dates/flight codes, destinations, general greetings, quoted security terms, contextual booking queries and harmless encodings. Deduplicate normalized payloads; keep variants/source families in the same split. Record source, license, revision, hash and reviewed labels. OWASP is taxonomy, not an executable payload dataset.

**Metrics**: TPR = TP/(TP+FN) >=95%; FPR = FP/(FP+TN) <=2%. At 200/500 this means >=190 attacks blocked and <=10 benign blocks. Report confusion matrix, per-stage rates, family counts, confidence intervals, skips, timeouts and errors. Require thresholds per stage and aggregate with minimum allocations input 100/250, tool 50/125 and output 50/125 (malicious/benign). Prove stage-local delivery before scoring; upstream rejection invalidates the case/run. Keep auth/quota/resource/side-effect invariants outside detector denominators. Infrastructure errors are not blocks and do not shrink denominators: fail the run as incomplete. Any unauthorized dispatch, cross-user access, PII/credential leak or booking/payment mutation fails independently of TPR. Stub-model tests prove deterministic boundaries, not universal live-model injection resistance.

## Static Analysis and CI Gates

Semgrep scans Python, TS/TSX and relevant YAML with pinned reviewed rules and custom checks for arbitrary imports/eval, disabled guardrails, model calls inside guardrails, unguarded ToolNode, raw result publication, unsafe HTML and sensitive logging. Each custom rule has vulnerable and safe fixtures. Cross-module lifecycle guarantees require contract tests; pattern scans alone cannot prove them.

Run SCA and secret scans separately. T003 selects pinned Gitleaks plus pip-audit and pnpm audit, with output schemas verified during implementation; use no paid cloud dependency. Record advisory database timestamps. Initial full-source baseline, change-aware PR scans and periodic full scans prevent blind spots. Hard boundary rules always block; zero unresolved Critical/High at release, including baseline findings. Lower findings require owner/rationale/fingerprint/compensating control and <=30-day expiry. Expired/broad suppressions fail.

Offline security tests/SAST run on applicable PRs. Full local DAST runs for runtime/security changes and before release; periodic full runs catch change-filter gaps. Extend `ci-status`, its evaluator and path filters for rules/corpus/scripts/lockfiles/auth. Only explicit change-detection not-applicable may skip; applicable skipped/cancelled jobs and missing reports fail. Preserve existing network guards and sole required branch check. Use pinned actions/images, minimal permissions, synthetic credentials and no privileged execution of untrusted PR code.

**Evidence**: commit SHA, tool/rule/policy/corpus versions, scope manifest, counts, endpoint census, coverage XML, JUnit, sanitized JSON/SARIF and ZAP reports, finding fingerprints/retests and final exit codes. Publish sanitized artifacts even on failure; absent expected reports fail. Retain sanitized CI evidence 30 days; remove restricted raw temporary output at cleanup. Security report sanitization itself has canary tests.

## Complexity Tracking

No violations. Gateway/controller resolve existing split responsibilities. Reuse current repositories, projections, telemetry and CI aggregation. Deterministic regex is not a proof against all semantic attacks; structural privileges and zero-leak invariants remain mandatory.

## Convergence Contract

The detailed cycle-1 decisions in `contracts/guardrail-boundaries.md` define detector spans, post-router capability sealing, stage-local score oracles, isolated evaluation versus real-quota profiles, bounded sharding, summary validation and pre-dispatch tracing restrictions. They are required design contracts, implemented by the revised tasks. Detector runs keep quota code active with isolated evaluation limits; production defaults remain unchanged. Validate generated summaries before persistence and suppress raw model callbacks before invocation.
