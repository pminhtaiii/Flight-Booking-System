---
description: "Dependency-ordered implementation tasks for deterministic flight match scoring"
---

# Tasks: Flight Match Scoring

**Input**: Design documents from `/specs/022-flight-match-scoring/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Required by FR-025 and `context/workflow.md`. Execute each behavioral slice RED → GREEN → REFACTOR; do not modify a written failing test without user approval.

**Organization**: Setup and foundational phases establish shared contracts, additive profile state, and normalized offer inputs. User-story phases then deliver independently verifiable matched ranking, cold-start ranking, UI transparency, and agent parity.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it owns different files and has no dependency on another incomplete task in the same wave.
- **[Story]**: Maps work to US1–US4 from `spec.md`.
- Every task names its primary file path.

## Phase 1: Setup — Strict Shared Contracts

**Purpose**: Make the cross-service contract explicit before any producer or consumer changes.

- [x] T001 Drive MATCHED eligibility/score/level/breakdown schemas one behavior at a time through RED → GREEN in `packages/shared/src/types/flight-search.types.spec.ts` and `packages/shared/src/types/flight-search.types.ts`
- [x] T002 Drive RANKED nullability, active-weight precision, key-specific explanation parameters, and provider-ID rejection one behavior at a time through RED → GREEN in `packages/shared/src/types/flight-search.types.spec.ts` and `packages/shared/src/types/flight-search.types.ts`
- [x] T003 Drive hour-window and price-sensitivity contracts one behavior at a time through RED → GREEN in `packages/shared/src/types/traveler-profile.types.spec.ts` and `packages/shared/src/types/traveler-profile.types.ts`
- [x] T004 Drive airline canonicalization, max-stops, and tri-state baggage contracts one behavior at a time through RED → GREEN and export them in `packages/shared/src/types/traveler-profile.types.spec.ts`, `packages/shared/src/types/traveler-profile.types.ts`, `packages/shared/src/types/index.ts`, and `packages/shared/src/index.ts`
- [x] T005 Drive legacy-response-as-RANKED and future mode-tagged upstream parsing through RED → GREEN before producer work in `apps/web/lib/server/flight-search.spec.ts` and `apps/web/lib/server/flight-search.ts`
- [x] T006 Run the shared/web contract gates and reconcile the trusted Nest boundary in `specs/022-flight-match-scoring/contracts/flight-search.openapi.yaml` with the provider-blind shared boundary

**Checkpoint**: Strict shared contracts compile and reject provider/PII expansion before persistence or runtime work begins.

---

## Phase 2: Foundational — Profile Persistence and Canonical Offer Inputs

**Purpose**: Add rollback-safe profile state, an internal scoring projection, and supplier-independent input normalization required by every story.

**⚠️ CRITICAL**: No user-story orchestration begins until this phase is complete.

- [ ] T007 Drive additive null-default/existing-row migration through RED → GREEN in `apps/api/test/traveler-profile-flight-match-migration.e2e-spec.ts`, `apps/api/prisma/schema.prisma`, and `apps/api/prisma/migrations/<timestamp>_add_flight_match_preferences/migration.sql`
- [ ] T008 Drive revision preservation and absence of any score table/column through RED → GREEN in `apps/api/test/traveler-profile-flight-match-migration.e2e-spec.ts` and the same additive migration
- [ ] T009 Drive hour-window/overnight/unknown-key DTO validation through RED → GREEN in `apps/api/src/profile/profile.controller.spec.ts` and `apps/api/src/profile/dto/update-profile.dto.ts`
- [ ] T010 Drive max-stops, sensitivity, baggage, airline canonicalization, and response DTO behavior through RED → GREEN in `apps/api/src/profile/profile.controller.spec.ts`, `apps/api/src/profile/dto/update-profile.dto.ts`, and `apps/api/src/profile/dto/profile-response.dto.ts`
- [ ] T011 Drive missing-profile, owner-scoped, readiness-flag-independent `getScoringPreferences()` through RED → GREEN in `apps/api/src/profile/profile.service.spec.ts` and `apps/api/src/profile/profile.service.ts`
- [ ] T012 Drive revision-CAS atomic update/clear, mapping, and safe changed-field audit behavior through RED → GREEN in `apps/api/src/profile/profile.service.spec.ts` and `apps/api/src/profile/profile.service.ts`
- [ ] T013 Extend owned profile API E2E coverage for the scoring fields and airline arrays in `apps/api/test/profile.e2e-spec.ts`
- [ ] T014 [P] Define immutable supplier-independent inputs, scoring preferences, eligibility, dimension, result, and internal orchestration types in `apps/api/src/flight-match/flight-match.types.ts`
- [ ] T015 Drive canonical order, local IDs, full-itinerary aggregates, outbound local-clock facts, carrier codes, longest cabin, and checked bags one behavior at a time through RED → GREEN in `apps/api/src/flights/flight-offer-normalizer.spec.ts` and `apps/api/src/flights/flight-offer-normalizer.ts`
- [ ] T016 Drive malformed-offer rejection, first-valid-currency selection, mixed-currency dropping, rejection counts, and all-invalid empty output through RED → GREEN in `apps/api/src/flights/flight-offer-normalizer.spec.ts` and `apps/api/src/flights/flight-offer-normalizer.ts`
- [ ] T017 Drive policy version, exact weights, cabin order, sensitivity multipliers, buckets, red-eye hours, and explanation allowlist one behavior at a time through RED → GREEN in `apps/api/src/flight-match/flight-match.policy.spec.ts` and `apps/api/src/flight-match/flight-match.policy.ts`
- [ ] T018 Drive clamp, round6, half-away final rounding, signal thresholds, circular-hour distance, and deterministic median helpers one behavior at a time through RED → GREEN in `apps/api/src/flight-match/flight-match.policy.spec.ts` and `apps/api/src/flight-match/flight-match.policy.ts`
- [ ] T019 Create the zero-import NestJS module scaffold in `apps/api/src/flight-match/flight-match.module.ts`; provider registration is completed only after each pure service exists
- [ ] T020 Drive legacy-null/window/sensitivity browser profile parsing through RED → GREEN in `apps/web/lib/profile.spec.ts`, `apps/web/lib/profile-contract.ts`, and `apps/web/lib/profile.ts`
- [ ] T021 Drive airline/max-stops/baggage profile serialization and clearing through RED → GREEN in `apps/web/lib/profile.spec.ts`, `apps/web/lib/profile-contract.ts`, and `apps/web/lib/profile.ts`
- [ ] T022 Run Prisma validation/generation, shared tests, profile unit/API tests, and normalizer/policy tests from `specs/022-flight-match-scoring/quickstart.md`

**Checkpoint**: Existing profiles remain valid, current profile CAS/security invariants hold, and raw Duffel data can be normalized without the scorer knowing Duffel.

---

## Phase 3: User Story 1 — Deterministic Personalized Matches (Priority: P1) 🎯 MVP

**Goal**: Return stable, explainable MATCHED results for any traveler with an effective scoring preference.

**Independent Test**: Seed one profile and a fixed eligible/ineligible offer set, call the search twice including a raw-cache hit, and assert identical eligibility, scores, levels, weights, explanations, ordering, and supplier call count.

### Eligibility and dimension scoring

- [ ] T023 [US1] Drive blacklist precedence across all carriers and stable violation explanations through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T024 [US1] Drive ineligible visibility, eligible-only references, duplicate-code handling, and frozen-input non-mutation one behavior at a time through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T025 [US1] Drive odd/even median PRICE and DURATION curves plus exact signal thresholds one behavior at a time through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T026 [US1] Drive sensitivity-modified PRICE and preference/relative STOPS behavior through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T027 [US1] Drive AIRLINE neutral/preferred and effective-query CABIN exact/adjacent/mismatch behavior through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T028 [US1] Drive overnight/boundary/shoulder schedules and baggage true/false/null behavior through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`

### Weight resolution and final ranking

- [ ] T029 [US1] Drive missing-personalized transfer, zero-variance redistribution, caps, and exact 1.000000 totals through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T030 [US1] Drive full-baseline-collapse against the entire transferred target using the airline-only 0.425/0.255/0.170/0.150 fixture plus single/all-ineligible fallbacks through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T031 [US1] Drive contribution precision, half-away rounding, and exact 24/25/49/50/74/75 match buckets through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`
- [ ] T032 [US1] Drive breakdown/metadata order, eligible-first score order, objective tie-breaks, and original-index stability through RED → GREEN in `apps/api/src/flight-match/flight-match-scorer.service.spec.ts` and `apps/api/src/flight-match/flight-match-scorer.service.ts`

### Canonical search orchestration

- [ ] T033 [US1] Drive canonical-first-20 normalization, one profile read, query-cabin precedence, and scorer invocation through RED → GREEN in `apps/api/src/flights/flight-search-orchestrator.service.spec.ts` and `apps/api/src/flights/flight-search-orchestrator.service.ts`
- [ ] T034 [US1] Drive current-profile rescoring on raw-cache hits, invalid-offer counts, aggregate metadata, and no score persistence through RED → GREEN in `apps/api/src/flights/flight-search-orchestrator.service.spec.ts` and `apps/api/src/flights/flight-search-orchestrator.service.ts`
- [ ] T035 [US1] Register/export `FlightMatchScorerService`, register/export the orchestrator, and add acyclic `ProfileModule`/`FlightMatchModule` imports in `apps/api/src/flight-match/flight-match.module.ts` and `apps/api/src/flights/flights.module.ts`
- [ ] T036 [US1] Drive cache-hit/miss upsert of missing `FlightOffer`/`OfferRecovery`, including agent-warmed raw cache followed by browser selection, through RED → GREEN in `apps/api/src/flights/flights.service.spec.ts` and `apps/api/src/flights/flights.service.ts`
- [ ] T037 [US1] Drive history/audit preservation, PII-safe mode/meta response, trusted DTO serialization, and private/no-store search headers with ETag removal through RED → GREEN in `apps/api/src/flights/flights.service.spec.ts`, `apps/api/src/flights/flights.controller.spec.ts`, `apps/api/src/flights/flights.service.ts`, `apps/api/src/flights/flights.controller.ts`, and `apps/api/src/flights/dto/search-flight.dto.ts`
- [ ] T038 [US1] Add MATCHED contract, private/no-store headers, repeated-run parity, blacklist visibility, raw-cache rescoring, no-extra-Duffel-call, and no-score-storage E2E coverage in `apps/api/test/flights-match-scoring.e2e-spec.ts`
- [ ] T039 [US1] Add and run the deterministic 1,000-repeat and warmed 20-offer p95 benchmark in `apps/api/src/flight-match/flight-match.performance.spec.ts`

**Checkpoint**: Personalized browser API searches are a deployable MVP with exact deterministic policy evidence and unchanged Duffel budget behavior.

---

## Phase 4: User Story 2 — Honest Cold-Start Ranking (Priority: P2)

**Goal**: Return useful RANKED results and no match claims when the profile contains no effective scoring preference.

**Independent Test**: Search a deliberately conflicting fixed offer set with no profile preferences and verify scorer non-invocation, RANKED mode, null results, and stops → price → duration → red-eye → original-index order.

- [ ] T040 [US2] Drive stops-price-duration-red-eye-original-index category ordering through RED → GREEN in `apps/api/src/flight-match/category-ranker.service.spec.ts` and `apps/api/src/flight-match/category-ranker.service.ts`
- [ ] T041 [US2] Drive empty/single/stable ties and frozen-input non-mutation through RED → GREEN in `apps/api/src/flight-match/category-ranker.service.spec.ts` and `apps/api/src/flight-match/category-ranker.service.ts`
- [ ] T042 [US2] Drive the personalization truth table for nulls, empty arrays, blacklist/maxStops/sensitivity-only, class-with-query, and false baggage through RED → GREEN in `apps/api/src/flights/flight-search-orchestrator.service.spec.ts` and `apps/api/src/flights/flight-search-orchestrator.service.ts`
- [ ] T043 [US2] Drive scorer non-invocation, RANKED mode, null match results, and ranker registration through RED → GREEN in `apps/api/src/flights/flight-search-orchestrator.service.spec.ts`, `apps/api/src/flights/flight-search-orchestrator.service.ts`, and `apps/api/src/flight-match/flight-match.module.ts`
- [ ] T044 [US2] Add empty-profile, missing-profile, empty-offer, and stable cold-start API E2E coverage in `apps/api/test/flights-match-scoring.e2e-spec.ts`
- [ ] T045 [US2] Prove cached/uncached RANKED searches preserve persistence/upserts, agent-warmed-cache browser selection, budget, rate-limit, and error behavior in `apps/api/test/flights-search.e2e-spec.ts`

**Checkpoint**: Existing travelers without preferences receive honest objective ranking and the scorer is not invoked.

---

## Phase 5: User Story 3 — Understand and Configure Matching (Priority: P3)

**Goal**: Let travelers edit supported preferences and understand mode-specific results without weakening browser privacy.

**Independent Test**: Save scoring preferences, search, inspect score/level/breakdown or constraint state, clear preferences, search again, and verify RANKED presentation/profile CTA with no unsafe browser data.

### Server boundary and explanation safety

- [ ] T046 [US3] Drive the post-producer required mode/match contract and removal of the temporary legacy fallback through RED → GREEN in `apps/web/lib/server/flight-search.spec.ts` and `apps/web/lib/server/flight-search.ts`
- [ ] T047 [US3] Drive malformed breakdown/unknown-parameter/provider-ID rejection and local-ID preservation through RED → GREEN in `apps/web/lib/server/flight-search.spec.ts` and `apps/web/lib/server/flight-search.ts`
- [ ] T048 [US3] Drive allowlisted airline/time/window/percentage/stop copy and primitive formatting through RED → GREEN in `apps/web/components/search/flight-match-explanations.spec.ts` and `apps/web/components/search/flight-match-explanations.ts`
- [ ] T049 [US3] Drive unknown-key fallback, missing/wrong parameter handling, and HTML-injection safety through RED → GREEN in `apps/web/components/search/flight-match-explanations.spec.ts` and `apps/web/components/search/flight-match-explanations.ts`

### Mode and profile vertical slices

- [ ] T050 [US3] Drive MATCHED score/level presentation through one Playwright RED → GREEN slice in `apps/web/tests/flight-match-scoring.spec.ts` and `apps/web/components/search/FlightMatchBadge.tsx`
- [ ] T051 [US3] Drive expandable dimension/constraint copy and ineligible-but-selectable behavior through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts` and `apps/web/components/search/FlightMatchBreakdown.tsx`
- [ ] T052 [US3] Drive RANKED no-score claims, profile CTA, and objective sort controls through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts`, `apps/web/components/search/FlightRankingBanner.tsx`, and `apps/web/components/search/FlightResultsControls.tsx`
- [ ] T053 [US3] Drive provider-blind ordered cards and default MATCHED order through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts`, `apps/web/components/search/FlightResultCard.tsx`, and `apps/web/components/search/FlightResults.tsx`
- [ ] T054 [US3] Drive full outcome/mode retention and result composition through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts` and `apps/web/components/search/SearchFormClient.tsx`
- [ ] T055 [US3] Drive class-profile prefill with submitted-query precedence through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts`, `apps/web/app/search/page.tsx`, and `apps/web/components/search/SearchFormClient.tsx`
- [ ] T056 [US3] Drive airline and overnight-window profile save/clear through RED → GREEN in `apps/web/tests/traveler-profile.spec.ts` and `apps/web/components/profile/TravelerProfileForm.tsx`
- [ ] T057 [US3] Drive max-stops, sensitivity, tri-state baggage, atomic invalid rejection, and stale-revision recovery through RED → GREEN in `apps/web/tests/traveler-profile.spec.ts` and `apps/web/components/profile/TravelerProfileForm.tsx`
- [ ] T058 [US3] Drive 360/768/desktop keyboard/accessibility behavior through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts` and the components under `apps/web/components/search/`
- [ ] T059 [US3] Drive zero-token/backend/provider/PII plus key-specific explanation allowlist assertions through RED → GREEN in `apps/web/tests/flight-match-scoring.spec.ts` and `apps/web/tests/characterization/search-seam.characterization.spec.ts`

**Checkpoint**: Travelers can configure and understand matching, while RANKED and MATCHED semantics remain distinct and browser-safe.

---

## Phase 6: User Story 4 — Agent and Search-Page Parity (Priority: P4)

**Goal**: Make chat consume the same canonical ordered facts and let the LLM narrate, never judge.

**Independent Test**: Run equivalent page and gateway requests against one orchestrator fixture and verify identical mode/order/match facts before safe projection, exact attestation order, and zero scorer/sort logic in Python.

- [ ] T060 [US4] Drive V2 delegation, canonical-20-before-five, mode/order, and no-direct-Duffel-search through RED → GREEN in `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts`, `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.module.ts`, and `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.ts`
- [ ] T061 [US4] Drive exact ranked-first-five persistence and selection-attestation order through RED → GREEN in `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts` and `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.ts`
- [ ] T062 [US4] Drive strict gateway mode/match DTO serialization without weakening trusted ID boundaries through RED → GREEN in `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts`, `apps/api/src/agent-gateway/dto/flight-result.dto.ts`, and `apps/api/src/agent-gateway/dto/attested-flight-search.dto.ts`
- [ ] T063 [US4] Drive V1 delegation, removal of query-only scored cache use, ownership/degradation/audit preservation, and failure mapping through RED → GREEN in `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts` and `apps/api/src/agent-gateway/attested-flight-search/attested-flight-search.service.ts`
- [ ] T064 [P] [US4] Prove strict trusted snapshot models reject score/level/weights/breakdown/version extras and persisted Redis payloads remain score-free in `apps/agent/tests/test_search_snapshot.py` and `apps/agent/tests/test_trusted_search_snapshot_lifecycle.py`
- [ ] T065 [US4] Drive an ID/PII-free transient immediate-response narration projection through RED → GREEN in `apps/agent/tests/test_tools.py` and `apps/agent/src/agent/tools/flight_match_projection.py`
- [ ] T066 [US4] Drive V2 MATCHED parsing, gateway-order preservation, and precomputed narration through RED → GREEN in `apps/agent/tests/test_tools.py`, `apps/agent/src/agent/tools/nestjs_client.py`, and `apps/agent/src/agent/tools/search_flights.py`
- [ ] T067 [US4] Drive RANKED honesty, unknown-key fallback, and explicit no-Python-scoring/no-sorting behavior through RED → GREEN in `apps/agent/tests/test_tools.py` and `apps/agent/src/agent/tools/search_flights.py`
- [ ] T068 [US4] Add browser-versus-attested mode/order/match parity, exact first-five projection, and gateway response privacy coverage in `apps/api/test/agent-flight-match-parity.e2e-spec.ts`
- [ ] T069 [US4] Update strict score-free snapshot and graph/tool characterization fixtures and run regressions in `apps/agent/tests/characterization/test_snapshot_characterization.py`, `apps/agent/tests/test_graph.py`, and `apps/agent/tests/test_chat_turn_runner.py`

**Checkpoint**: Agent and page recommendations share one deterministic source, and every LLM-facing fact is precomputed and privacy-safe.

---

## Phase 7: Polish and Cross-Cutting Verification

**Purpose**: Close operational, documentation, performance, security, and full-regression gates.

- [ ] T070 Drive bounded mode/version/count/error metrics through RED → GREEN in `apps/api/src/common/observability/flight-match.metrics.spec.ts`, `apps/api/src/common/observability/flight-match.metrics.ts`, and `apps/api/src/common/observability/flight-match-metrics.module.ts`
- [ ] T071 Drive latency, trace/correlation, invalid-offer counts, and negative-PII/cardinality behavior through RED → GREEN and register the module in `apps/api/src/common/observability/flight-match.metrics.spec.ts`, `apps/api/src/common/observability/flight-match.metrics.ts`, and `apps/api/src/flights/flights.module.ts`
- [ ] T072 Document policy rollout/rollback, SLO/alerts, cache-call invariants, telemetry cardinality, privacy, and incident diagnosis in `docs/runbooks/flight-match-scoring.md`
- [ ] T073 Update final module/data-flow, cache, profile, browser, and agent boundaries in `context/architecture.md`
- [ ] T074 Record completed phases and actual verification evidence only after all gates pass in `context/progress-checker.md`
- [ ] T075 Run Prisma/shared/API unit, migration, API E2E, lint, typecheck, no-score-persistence, and benchmark gates from `specs/022-flight-match-scoring/quickstart.md`
- [ ] T076 Run web unit, characterization, Playwright, accessibility, privacy, lint, typecheck, and production-build gates from `specs/022-flight-match-scoring/quickstart.md`
- [ ] T077 Run agent pytest/ruff/SSE/trusted-snapshot regressions and repository scans for duplicate scoring, direct agent Duffel search, provider leaks, score tables, and score cache keys from `specs/022-flight-match-scoring/quickstart.md`

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: Starts immediately.
- **Phase 2 (Foundational)**: Depends on strict shared types from Phase 1 and blocks all user stories.
- **US1 / Phase 3**: Depends on Phase 2; delivers the personalized-scoring MVP.
- **US2 / Phase 4**: Depends on Phase 2 policy/types and shares the orchestrator created by US1; execute after T034 or coordinate edits explicitly.
- **US3 / Phase 5**: Profile controls may start after Phase 2; result UI depends on US1/US2 final response contracts.
- **US4 / Phase 6**: Depends on the canonical orchestrator from US1/US2 but is independent of visual UI component implementation.
- **Phase 7 (Polish)**: Depends on every user story selected for release.

### User-story dependencies

- **US1 (P1)**: First shippable slice after foundation; no dependency on another story.
- **US2 (P2)**: Uses the US1 orchestrator file but its category ranker is independently testable; completes the no-profile branch.
- **US3 (P3)**: Consumes US1/US2 contracts and can be tested independently with mocked strict server outcomes.
- **US4 (P4)**: Consumes US1/US2 orchestrator and can be tested independently of US3 using API/gateway fixtures.

### Within each story

- Write one failing behavioral test, confirm RED, implement the minimum GREEN change, run existing tests, then refactor.
- Types/policy before services; pure services before orchestration; orchestration before transport/UI projections.
- Do not mark a task complete while its test or any prior test is failing.

## Parallel Opportunities

- After T006, migration test/schema work (T007–T008) and shared-independent API type work (T014) can proceed separately.
- After Phase 2, pure scorer slices and web profile-control preparation can proceed in separate workspaces if shared contracts are frozen.
- T050 MATCHED badge work and T056 profile-window work can proceed in parallel after T049 because they own different tests/components.
- T064 owns Python snapshot invariants and can run in parallel with T063 after the gateway response contract T062 is frozen.
- US3 UI implementation and US4 gateway/agent implementation can run in parallel after US1/US2 orchestrator contracts pass.

## Parallel Examples

### User Story 1

```text
Task A: T035 module/orchestrator wiring after the scorer is green
Task B: T039 isolated benchmark harness in flight-match.performance.spec.ts
```

Both start only after T032; neither may weaken scorer fixtures.

### User Story 3

```text
Task A: T050 MATCHED badge Playwright RED/GREEN slice
Task B: T056 airline/window profile Playwright RED/GREEN slice
```

### User Story 4

```text
Task A: T063 V1 gateway delegation/cache RED/GREEN slice
Task B: T064 strict score-free Python snapshot invariant tests
```

## Implementation Strategy

### MVP first

1. Complete shared contracts and additive profile foundation.
2. Complete US1 scorer and MATCHED public API.
3. Stop and validate deterministic fixtures, raw-cache rescoring, no extra Duffel calls, no persistence, and the 20-offer benchmark.
4. Demonstrate API output before adding cold-start/UI/agent surfaces.

### Incremental delivery

1. **Foundation**: migration + contracts + normalized inputs.
2. **US1**: deterministic MATCHED API.
3. **US2**: honest RANKED API.
4. **US3**: profile/search UI transparency.
5. **US4**: agent parity and safe narration.
6. **Polish**: observability, docs, full regression, rollout.

### Rollback order

1. Deploy tolerant web/agent consumers before the new API producer.
2. If rollback is needed, remove/disable the producer first; consumers interpret legacy output as RANKED.
3. Roll consumers back only after producer rollback.
4. Leave additive nullable profile columns in place; they require no destructive rollback.

## Task Summary

- **Total tasks**: 77
- **Setup/Foundation**: 22
- **US1**: 17 tasks (T023–T039)
- **US2**: 6 tasks (T040–T045)
- **US3**: 14 tasks (T046–T059)
- **US4**: 10 tasks (T060–T069)
- **Polish/Cross-cutting**: 8 tasks (T070–T077)
- **Suggested MVP**: Phase 1 + Phase 2 + User Story 1

## Notes

- `[P]` means file ownership is disjoint and prerequisites are already complete; it does not override TDD order.
- Generated `.js` duplicates are not implementation targets unless the existing package build explicitly regenerates them.
- Do not add a scoring feature flag, score table, score Redis key, LLM scorer, ninth dimension, direct agent scorer import, or direct Python ordering logic.
- Context files are updated after feature verification, not during partial implementation.
