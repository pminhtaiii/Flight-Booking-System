# Security Test Coverage Matrix

Every listed path is a planned implementation target. Each layer needs pass/block/boundary/error tests. Coverage percentages never replace explicit security oracles.

| ID / requirement | Surface / attack | Required test and oracle | Tasks |
|---|---|---|---|
| SEC01 / FR-001 | SSE/controller/direct runner bypass; absent gateway | `apps/agent/tests/security/test_enforcement.py`: zero router/model/tool calls | T008,T012,T015,T018 |
| SEC02 / FR-002 | Registry imports, missing layers, unsafe ordering | `apps/agent/tests/security/test_registry.py`: startup fails without code execution | T009,T013 |
| SEC03 / FR-003,004 | LengthValidator UTF-8/byte/token boundaries | `apps/agent/tests/security/test_input_layers.py`: limit-1/limit/limit+1 before decoding | T014,T016 |
| SEC04 / FR-004 | Input PIIDetector versus travel numbers | Same input tests: synthetic credential block; benign price/date/flight code pass | T014,T016 |
| SEC05 / FR-003 | InjectionDetector Unicode/control/nested encodings | `apps/agent/tests/security/test_normalization.py`: >=50 signatures, bounded expansion, benign variants | T014,T016,T017 |
| SEC06 / FR-004 | TopicBoundary off-topic versus greetings/follow-ups | Input tests: deterministic travel/greeting pass or static redirect; no judge | T014,T016 |
| SEC07 / FR-004 | SizeStructureValidator depth/bytes/nodes/invalid JSON | `apps/agent/tests/security/test_tool_layers.py`: bounded parse and zero exposure | T021,T024 |
| SEC08 / FR-004,005 | SchemaValidator wrong types/extra keys/forged signals | `apps/agent/tests/security/test_tool_schemas.py`: six exact models, separate private controls | T022,T025 |
| SEC09 / FR-004,005 | Tool PIIScanner nested synthetic canary | Tool layer tests: no forbidden content in model/events/state/logs | T021,T024,T027 |
| SEC10 / FR-003,005 | UntrustedContentInjectionDetector indirect instructions | `apps/agent/tests/security/test_tool_boundary.py`: no contaminated ToolMessage/checkpoint/signal/trace | T021,T026,T027 |
| SEC11 / FR-004,006 | ChunkBuffer every split/EOF/no punctuation | `apps/agent/tests/security/test_output_stream.py`: withheld suffix never leaks; bounded memory | T019,T020 |
| SEC12 / FR-004,006 | Output PIIScanner adjacent chunks/Unicode/sentences | Same output tests: received bytes and approved persistence contain no protected canary | T019,T020 |
| SEC13 / FR-005 | Unknown/mixed tool batches, forged intent | `apps/agent/tests/security/test_tool_authority.py`: zero unauthorized invocation across every tool/intent | T023,T026 |
| SEC14 / FR-005 | Cross-user booking/session, JWT/claim replay, handoff/fence | `tests/security/dast/test_ownership.py`: established rejection and no unauthorized read/write | T038,T040 |
| SEC15 / FR-006 | Disconnect/timeout/Redis outage/concurrent buffers | `apps/agent/tests/security/test_lifecycle.py`: fail closed, no cross-turn data, cleanup order preserved | T018,T020,T027 |
| SEC16 / FR-007,008 | Unsafe Python/TS/TSX/YAML or broken rule scope | `tests/security/sast/fixtures/`: vulnerable detected, safe accepted, full source census | T029–T032 |
| SEC17 / FR-007,008 | Vulnerable dependency/secret or unavailable feed | `tests/security/supply-chain.test.mjs`: separate results; execution error fails | T003,T033 |
| SEC18 / FR-007 | XSS/injection/CORS/CSRF/redirect/traversal | `tests/security/dast/test_http_security.py`, `apps/web/tests/security-boundaries.spec.ts`: authenticated scanner and browser evidence | T037–T040 |
| SEC19 / FR-007 | Held-out prompt/tool/output attacks and benign cases | `tests/security/dast/test_adversarial.py`: 200+/500+, TPR/FPR per stage and complete denominators | T004,T006,T036,T039,T041 |
| SEC20 / FR-008 | Missing reports, cancelled/skipped jobs, stale exceptions | `tests/ci/ci-workflow.contract.test.mjs`: applicable failure reaches ci-status | T005,T010,T034,T035 |
| SEC21 / FR-009 | Malicious event fields/sink outage | `apps/agent/tests/security/test_security_events.py`: no payload/PII, bounded labels, BLOCK unchanged | T042,T044,T045 |
| SEC22 / FR-009 | ReDoS/decode expansion/long concurrent streams | `apps/agent/tests/security/test_security_performance.py`: bounded resources and SC-004 distributions | T043,T046 |
| SEC23 / FR-005,006 | Checkout/attestation/scoring regressions | Existing T001-inventoried tests: preserve authorized handoff; no model-driven payment/booking | T027,T028,T047,T049 |
| SEC24 / FR-001,003,004 | Oversized raw request/provider bodies, false or missing Content-Length, chunked/compressed expansion | `apps/agent/tests/security/test_body_limits.py`: bounded reads before parsing or allocation; safe transport error | T018,T024 |
| SEC25 / FR-001,003,004 | Stored history/summary injection and PII replay | `apps/agent/tests/security/test_enforcement.py`: no unchecked history enters summarizer/router/model; safe reject/quarantine | T012,T018,T039 |
| SEC26 / FR-004,006 | Unbounded PII patterns/normalization mapping/overlong candidates | `apps/agent/tests/security/test_output_stream.py`: policy widths and lookaround proven at every max/overflow split | T019,T020 |
| SEC27 / FR-005 | Router fallback/provenance, downgrade, single-agent and later-node expansion | `apps/agent/tests/security/test_tool_authority.py`: post-gate seal, empty invalid authority, node intersection | T008,T023,T026 |
| SEC28 / FR-007,008 | Upstream block falsely credited as downstream detection | `tests/security/dast/test_adversarial.py`: expected-stage marker, fixed allocations, separate invariants, incomplete-run failure | T005,T006,T036,T039,T041 |
| SEC29 / FR-007 | Evaluation quota exhaustion/shard omissions/non-repeatable state | `tests/security/dast/test_quota_profiles.py`: isolated profile, unchanged-default quota checks, scoped reset and complete union | T007,T041 |
| SEC30 / FR-001,004,006 | Generated summary or model callback leaks before validation | `apps/agent/tests/security/test_memory_boundary.py`, `test_model_output_boundary.py` in same directory: no raw capture/state export/persistence/reuse; lower-trust memory framing | T012,T018,T020,T039 |

## Release Evidence Rules

- All SEC IDs need executed evidence; no waived structural privacy/authorization invariant.
- Ten layers each need positive, negative, boundary and error cases. Changed security modules include imported controller/gateway/registry/executor/pipelines/layers, streaming/ASGI middleware, startup/config, tool clients/projections, memory and reused sanitizer modules in coverage: >=95% statements and >=90% branches.
- Explicitly enumerate critical allow/block/error transitions. Disposable mutations removing input validation, dispatch authorization, result scanning or output holdback must each make targeted tests fail.
- TPR/FPR measure detector performance, not static-analysis precision or API authorization. Report separately; zero scanner findings require positive fixture controls and real scope coverage.
- Report local-model-stub DAST honestly; no claim of live-model robustness or production resistance from those results.
