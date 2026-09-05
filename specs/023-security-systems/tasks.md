# Tasks: Deterministic Guardrails and Security Verification

**Input**: `specs/023-security-systems/{spec,plan,research,data-model}.md`, contracts and security test matrix.
**Status**: All tasks pending. This checklist plans implementation; it does not claim tests or scanners have run.
**Format**: `- [ ] Tnnn [P?] [USn?] action with file path`. `[P]` means independent file work after stated prerequisites. Tests precede the implementation they verify. New paths are intentional implementation targets.

## Phase 1: Setup

Goal: reproducible inventory and baseline. Exit: every entry point, tool, schema, sensitive sink and runtime prerequisite is identified.

- [x] T001 Inventory actual routes, six tool contracts, state/event/log sinks, auth/quotas and resource limits in `docs/security/guardrail-inventory.md`; map existing test names and validate proposed caps against legitimate payloads before coding.
- [x] T002 [P] Capture existing SSE, runner cleanup, handoff and output behavior in `apps/agent/tests/security/test_characterization.py`; distinguish intended security corrections from compatibility guarantees.
- [x] T003 [P] Pin Semgrep/rules, ZAP image digest, Gitleaks, pip-audit, pnpm audit runtime and pytest-cov in `tests/security/toolchain.json` and `apps/agent/pyproject.toml`; document verified commands/output schemas, licenses and advisory freshness in `docs/security/toolchain.md` and refresh `uv.lock` only as needed.
- [x] T004 [P] Define reviewed corpus provenance, label rules, split/dedup procedure and pinned taxonomy edition in `tests/security/corpus/README.md`; set at least 200 attack and 500 benign holdout cases separate from development data.

## Phase 2: Foundation

Goal: shared contracts and trustworthy evidence. Exit: harness distinguishes protection from missing coverage/infrastructure failure. Depends on Phase 1.

- [x] T005 Implement report schema and tests for success, policy failure, timeout, missing/invalid report, auth failure and expired exceptions in `scripts/security/evaluate-results.mjs` and `tests/security/evaluate-results.test.mjs`; require counts, versions and final exit codes. Enforce the stage-reachability, invariant separation and complete shard-union report contract in `contracts/guardrail-boundaries.md` under this feature.
- [x] T006 [P] Add corpus schema/loader and tests in `tests/security/corpus/schema.json`, `scripts/security/validate-corpus.mjs` and `tests/security/corpus-contract.test.mjs`; reject duplicate IDs/normalized cases, cross-split variants, missing license/hash and empty stage denominators. Require suiteKind, expectedStage/layer family, delivery fixture and oracle; enforce detector allocations input 100/250, tool 50/125 and output 50/125 with separate invariant suites.
- [ ] T007 [P] Create local stack orchestration in `scripts/security/run-local-dast.mjs` and `tests/security/compose.security.yml`: two synthetic users, isolated DB/Redis, model/provider stubs, explicit host/address/redirect allowlist, request/time caps and cleanup; test out-of-scope refusal without changing existing network guards. Implement isolated detector quota profile (10000/day, 600/min) and separate unchanged-default quota-invariant profile; reset only disposable run state between repeats and use fixed bounded shard manifests if needed, as specified in the boundary contract.
- [ ] T008 Define strict admission/capability/decision/layer contracts and static response keys in `apps/agent/src/agent/guardrails/base.py` and `apps/agent/tests/security/test_contracts.py`; raw rejected content is inaccessible on BLOCK. Define separate AdmissionContext and post-router TurnCapabilities with trusted provenance; no tool authority exists during input checking.
- [ ] T009 Add registry contract tests in `apps/agent/tests/security/test_registry.py` for unknown/duplicate keys, dynamic import strings, required layer disablement, invalid order and valid test injection.
- [x] T010 [P] Implement sanitized evidence writer and canary tests in `scripts/security/write-report.mjs` and `tests/security/report-privacy.test.mjs`; allowlist report fields and redact raw ZAP/corpus payloads before upload.
- [ ] T011 Register security test markers and coverage scope in `apps/agent/pyproject.toml` and `tests/security/coverage-policy.json`; include changed controller/gateway/registry/executor/layers, streaming, startup/config, tool clients/projections, memory and sanitizer modules and target >=95% statements, >=90% branches.

## Phase 3: US1 — Protect Every Chat Turn (P1, integration MVP)

Goal: mandatory input/output protection regardless of adapter. Independent test: valid travel/greeting reaches model; malicious input causes zero router/model/tool calls; every synthetic output PII partition is withheld; missing gateway fails closed. Depends on Phase 2.

- [ ] T012 [US1] Add adapter/direct-runner enforcement tests in `apps/agent/tests/security/test_enforcement.py`, including absent gateway, classifier exceptions, persisted history/summary injection and PII replay, and zero model calls on input/history block. Include lower-trust history framing, newly generated summary validation before create_message, summary error canaries and raw model callback restrictions.
- [ ] T013 [US1] Implement closed registry and dependency-ordered compulsory production composition in `apps/agent/src/agent/guardrails/registry.py`; satisfy T009 and prohibit arbitrary config imports.
- [ ] T014 [P] [US1] Add malicious/benign/exact-boundary tests for all four input layers in `apps/agent/tests/security/test_input_layers.py` and `test_normalization.py` in the same directory; cover Unicode length, multilingual greetings/travel, malformed/nested encodings and repetitive regex inputs.
- [ ] T015 [US1] Implement mandatory gateway and thin controller in `apps/agent/src/agent/guardrails/gateway.py` and `apps/agent/src/agent/chat_turn/controller.py`; expose required validated-result interfaces without unrestricted fallbacks.
- [ ] T016 [US1] Implement LengthValidator, PIIDetector, InjectionDetector and TopicBoundary in `apps/agent/src/agent/guardrails/input_pipeline.py` and `guardrails/layers/input.py` under the same agent root; enforce bounded inspection and reviewed travel exceptions.
- [ ] T017 [US1] Add >=50 reviewed compiled injection signatures and bounded normalization in `apps/agent/src/agent/guardrails/layers/injection.py`; map each signature to malicious and benign tests from T014, measuring expansion/round limits.
- [ ] T018 [US1] Wire mandatory input validation into `apps/agent/src/agent/chat_turn/runner.py`, delegate through controller in `streaming/sse.py`, and update `main.py` under the same agent root; preserve authentication/admission; add bounded raw ASGI request reads before JSON decoding in `apps/agent/src/agent/middleware/body_limit.py`, testing absent/false Content-Length and chunked overflow. Validate loaded memory and summaries before summarizer/router/model calls in `apps/agent/src/agent/memory/manager.py` (reject/quarantine unsafe history, never silently send it onward); characterize cleanup in `apps/agent/tests/security/test_lifecycle.py`. Keep history out of SystemMessage, validate generated summaries before persistence/use, discard unsafe generated summaries and statically reject unsafe loaded history. Add these summary-path assertions to `apps/agent/tests/security/test_memory_boundary.py` before implementation.
- [ ] T019 [P] [US1] Write exhaustive split/partition, EOF, punctuation, long-stream, interleaved-user and cancellation tests in `apps/agent/tests/security/test_output_stream.py`; assert both received bytes and persisted approved-prefix confidentiality. Define `tests/security/pii-policy.json` with the detector-specific widths and 512-scalar match/lookaround ceiling from the contract; test maximum and overlong candidates, normalized-to-raw mapping, combining marks and callback/trace canaries.
- [ ] T020 [US1] Refactor `apps/agent/src/agent/guardrails/output_pipeline.py` and `streaming/chunk_buffer.py` for bounded pre-emission holdback and deterministic PII hard-stop; remove guardrail classifier/probe dependencies in `guardrails/nemo.py`, `main.py` and `config.py` without breaking primary-model configuration; prove no secondary security model requests. Install payload-free tracing/callback policy before all model invocations in `apps/agent/src/agent/agents/chat_agent.py`, agent nodes and `graph/nodes.py`; validate non-streamed AIMessage and SUMMARY values before state export, next-model input or persistence. Test `apps/agent/tests/security/test_model_output_boundary.py` before wiring these paths.

Checkpoint: six input/output components and all runner entry paths covered. MVP may be integrated behind disabled chat exposure; production release still requires US2–US5 and closure.

## Phase 4: US2 — Constrain Tool Authority and Results (P1)

Goal: dispatch least privilege and four result layers. Independent test: forge forbidden calls and malicious tool results while input checks pass; no forbidden invocation or model/state/event leakage. Depends on US1 interfaces; run tests before executor changes.

- [ ] T021 [P] [US2] Add result size/depth/node/PII/injection and pre-state exposure tests in `apps/agent/tests/security/test_tool_layers.py` and `test_tool_boundary.py` in the same directory; capture callbacks/checkpoints/model requests, not only runner events.
- [ ] T022 [P] [US2] Add strict six-tool schema tests in `apps/agent/tests/security/test_tool_schemas.py`: wrong types/coercion, unknown fields, malformed JSON and forged signals; preserve private attestation channels separately.
- [ ] T023 [P] [US2] Test every registered tool against every effective intent in `apps/agent/tests/security/test_tool_authority.py`; include GENERAL/unknown, malformed-deny/valid-low-confidence router fallback, forged names, multi-call mixed batches and zero downstream invocations on denial. Cover every capability-table row, raw router provenance forgery, checkout downgrade, single-agent flag, later route transitions and model-bind intersection with sealed capabilities.
- [ ] T024 [US2] Implement SizeStructureValidator, SchemaValidator, PIIScanner and UntrustedContentInjectionDetector in `apps/agent/src/agent/guardrails/tool_output_pipeline.py` and `guardrails/layers/tool_output.py`; bound raw parsing before strict schema/projection/scans. Bound streamed upstream response reads before JSON parsing in `apps/agent/src/agent/tools/nestjs_client.py`; test absent/false Content-Length, chunked overflow and compressed expansion in `apps/agent/tests/security/test_body_limits.py`, using synthetic responses without supplier traffic.
- [ ] T025 [US2] Define all six minimized tool models in `apps/agent/src/agent/guardrails/schemas/tools.py` and adapt `tools/search_flights.py`, `tools/get_preferences.py`, `tools/booking_summaries.py`, `tools/booking_detail.py`, `tools/check_booking_readiness.py`, `tools/signal_checkout_intent.py` under the same agent root; distinguish trusted internal signals from narration.
- [ ] T026 [US2] Replace unrestricted ToolNode dispatch in `apps/agent/src/agent/graph/nodes.py` using registry capabilities from `tools/registry.py` and a mandatory runner-supplied gateway executor from `chat_turn/runner.py`; scan before ToolMessage/state/signal/tracing publication. Update `apps/agent/src/agent/graph/router.py`, `graph/graph.py` and `graph/checkout_gate.py` to preserve provenance and seal capabilities after the gate; malformed/unknown results now deny tools rather than silently acquiring SEARCH authority.
- [ ] T027 [US2] Add full boundary regressions in `apps/agent/tests/security/test_tool_integration.py` for forged handoff/snapshot, blocked results, safe public tool events, telemetry canaries, validation errors and Redis/disconnect cleanup; retain existing runner and snapshot tests.
- [ ] T028 [US2] Run existing handoff/attestation/scoring API and agent tests selected by T001; record exact commands, counts and exit codes in `docs/security/tool-boundary-validation.md`, including zero booking/payment mutations and preserved authorized ACTION_HANDOFF delivery.

## Phase 5: US3 — Enforce Static Security Checks (P1)

Goal: reproducible static gates. Independent test: injected vulnerable fixture fails, safe fixture passes, missing report and skipped applicable job fail ci-status. Can start after Phase 2; boundary rules finalize against US1/US2 paths.

- [ ] T029 [P] [US3] Add safe/unsafe Python and TypeScript custom-rule fixtures in `tests/security/sast/fixtures/`; cover model calls in guardrails, dynamic imports, bypass dispatch, raw payload logging/publication and unsafe HTML.
- [ ] T030 [US3] Implement pinned custom rules in `tests/security/sast/guardrails.yml` plus reviewed generic rules in `tests/security/sast/ruleset.yml`; satisfy T029 and document which interprocedural properties need behavioral tests.
- [ ] T031 [P] [US3] Implement source/exclusion census and full/diff scan driver in `scripts/security/run-sast.mjs`; enforce pinned rules, fixture separation, expected scanned-file counts and nonzero exit on rule/scanner errors.
- [ ] T032 [US3] Establish full-source baseline and <=30-day exception schema in `tests/security/sast/baseline.json` and `tests/security/exceptions.json`; block hard boundary rules and unresolved Critical/High, with owner/rationale/compensating control for eligible lower findings.
- [ ] T033 [P] [US3] Implement separate SCA and secret drivers in `scripts/security/run-supply-chain.mjs`; test synthetic vulnerability/secret controls, unavailable feeds and report sanitization in `tests/security/supply-chain.test.mjs`.
- [ ] T034 [US3] Extend `tests/ci/ci-workflow.contract.test.mjs` and evaluator tests for security jobs, path-filter changes, missing/cancelled/applicable-skipped jobs and reports; preserve explicit not-applicable behavior and sole ci-status requirement.
- [ ] T035 [US3] Integrate security jobs into `.github/workflows/ci.yml` and `scripts/ci/evaluate-ci-status.mjs`; include corpus/rules/config/scripts/lockfile/auth changes, pinned actions, least permissions, failure artifact upload and periodic full scans without privileged untrusted PR execution.

## Phase 6: US4 — Execute Runtime Penetration Coverage (P1)

Goal: measured attack resistance against real local boundaries. Independent test: locked corpus, authenticated route census and canary/side-effect evidence pass; scanner failure or all-401 run fails. Depends on US1/US2 and report/CI interfaces.

- [ ] T036 [US4] Curate and freeze holdout/development JSONL plus license/source/hash manifest in `tests/security/corpus/`; include >=200 unique malicious and >=500 benign holdout cases, nonzero per-stage denominators and family-separated splits; never tune against holdout. Allocate detector cases input 100/250, tool 50/125 and output 50/125; keep authorization/quota/resource/side-effect cases in a separate required invariant manifest.
- [ ] T037 [P] [US4] Create `scripts/security/run-zap.mjs` and its runner contract tests in `tests/security/zap-runner.test.mjs`, alongside route/method/auth inventory and scoped ZAP configuration in `tests/security/zap/automation.yaml` and `tests/security/zap/routes.json`. Write runner tests before implementation: pinned toolchain invocation, authenticated target/redirect scope, bounded execution and cleanup, exit-code/finding policy, missing/invalid report failure, and sanitized evidence via T010. Verify the executable interface consumed by the T007 local harness without modifying that harness concurrently; finish runner/config validation before T040 invokes ZAP.
- [ ] T038 [P] [US4] Build two-user JWT/claim/ownership/replay/fencing tests in `tests/security/dast/test_ownership.py`; cover expired/revoked/forged claims, missing service key, wrong-owner session/booking, stale snapshots and handoff replay with no unauthorized side effects.
- [ ] T039 [P] [US4] Build adversarial HTTP/SSE replay in `tests/security/dast/test_adversarial.py`: direct/multi-turn/encoded prompts, malicious upstream tool stubs and output partitions; capture model/tool invocations and all forbidden-value sinks with deterministic local model stubs. Use benign carrier turns for tool/output candidates and require payload-free expected-stage reachability markers; upstream block invalidates the run rather than counting as TP.
- [ ] T040 [US4] Add conventional HTTP/browser security checks in `tests/security/dast/test_http_security.py` and `apps/web/tests/security-boundaries.spec.ts` for XSS/injection, CORS, CSRF, redirects, traversal and authenticated access; after T037 creates and verifies the runner, run scoped active/passive ZAP via `scripts/security/run-zap.mjs` with explicit exit-code/finding policy.
- [ ] T041 [US4] Run complete DAST twice on the same commit/corpus; publish sanitized aggregate/per-stage TPR/FPR, family outcomes, confusion counts, confidence intervals, authenticated route coverage and invariants in `docs/security/dast-validation.md`; infrastructure errors/timeouts/skips invalidate runs, and any authorization/privacy breach fails regardless of aggregate score. Verify shard union completeness and profile/reset manifests; compare semantic corpus results, excluding nondeterministic metadata. Run real-quota exhaustion and Redis outage assertions separately from corpus scores.

## Phase 7: US5 — Observe, Measure and Release (P2)

Goal: payload-free operations and safe rollout. Independent test: emitter failure preserves block, resource probes stay bounded and rollback never enables unguarded chat. Depends on runtime stories; final release evidence depends on US3/US4.

- [ ] T042 [P] [US5] Add event-schema/privacy/canary/cardinality/sink-outage tests in `apps/agent/tests/security/test_security_events.py`; include PASS/BLOCK and distinguish skipped layers from passes.
- [ ] T043 [P] [US5] Add reproducible warm/cold and hostile near-limit benchmarks in `apps/agent/tests/security/test_security_performance.py`; report p50/p95/p99, hardware, memory, concurrency and buffer wait separately from guardrail compute.
- [ ] T044 [US5] Implement SecurityEventEmitter in `apps/agent/src/agent/observability/security_events.py`; integrate gateway decisions with existing telemetry conventions, restricted HMAC subjectRef/keyId and no raw userId or high-cardinality metric labels.
- [ ] T045 [US5] Define block/latency/error dashboards, pseudonym retention/rotation and alert runbook in `docs/security/observability.md` and `tests/security/observability-contract.json`; derive false-positive trends from labeled evaluations/triage, not raw block counts.
- [ ] T046 [US5] Run T043 benchmarks against proposed SC-004 and resource ceilings; record evidence and fix breaches in `docs/security/performance-validation.md`; do not silently lower thresholds when failing.
- [ ] T047 [US5] Rehearse rollout/rollback and fail-closed startup with tests in `apps/agent/tests/security/test_rollout.py` and `docs/security/rollout.md`; retain existing handoff flags and disable chat safely if a protected build cannot start.

## Phase 8: Closure and Cross-Cutting Verification

Goal: reviewable release evidence. Depends on all stories.

- [ ] T048 Perform disposable mutation controls removing input check, dispatch allowlist, result scan and output holdback; require targeted tests to catch each mutation and record coverage/critical-transition evidence in `docs/security/coverage-validation.md`.
- [ ] T049 Run change-aware existing static/API/web/agent gates and all security suites using `specs/023-security-systems/quickstart.md`; record final exit codes, counts, skipped gates with justification and artifact hashes in `docs/security/release-evidence.md`.
- [ ] T050 Triage/reproduce/fix/retest every release-blocking finding and benign neighbor; maintain fingerprint/owner/severity/retest ledger in `docs/security/findings.md`; no unresolved Critical/High or invariant failures at release.
- [ ] T051 [P] Sync implemented behavior and remaining work in `context/architecture.md`, `context/progress-checker.md` and `context/library-docs.md`; document verified scanner commands without presenting planned work as shipped.
- [ ] T052 Perform independent security/spec review and verify all SEC matrix rows have actual evidence in `docs/security/release-evidence.md`; mark tasks complete only after their exit criteria and close any review corrections.

## Dependencies and Parallel Execution

`Phase 1 -> Phase 2 -> US1 -> US2 -> US4 -> US5 release -> Closure`; US3 branches from Phase 2 and rejoins before release. US5 test drafting can proceed after US1 interfaces stabilize. Tasks without [P] execute in listed order within their story unless explicitly stated otherwise. [P] tasks still await the prerequisite phase and their required contracts.

- Setup: T002/T003/T004 own distinct files; all complete before foundation.
- US1: after T013, T014 input tests can pair with T015 gateway work; T019 output tests can pair with T016/T017 input implementation. T018 and T020 serialize shared runner/startup changes. T019 policy/tests must finish before T020; T012/T018 memory tests and T020 model-output tests precede their respective wiring.
- US2: T021/T022/T023 are independent test files. T024/T025/T026 serialize schema, pipeline and executor integration.
- US3: T029 fixtures and T031 census can run together after foundation; T033 supply-chain work is independent. T034 precedes T035 CI mutations.
- US4: after T036, T037 ZAP runner/configuration, T038 ownership and T039 replay can run in parallel on separate files; all join at T040/T041.
- US5: T042 events and T043 benchmarks can run in parallel; T044–T047 integrate sequentially.
- Closure: T051 documentation may run alongside finding retests, but T052 requires final evidence.

## Delivery and Counts

52 tasks: setup 4, foundation 7, US1 9, US2 8, US3 7, US4 6, US5 6, closure 5. Smallest MVP is US1 integration with safe exposure controls; complete security release requires all phases. All test thresholds are planned gates, not current measured coverage.
