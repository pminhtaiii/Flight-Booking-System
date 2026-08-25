# Phase 8B implementation prompt — observability and performance gates

You are continuing Feature 017, Chatbot Backend Infrastructure and Booking Handoff, after Phase 8A documentation and the separately completed Phase 7D/T093 browser observation flow.

Use the named `$speckit-implement` workflow from `.agents/skills/speckit-implement/SKILL.md` for this session. Read that skill completely before acting. Also read `AGENTS.md`, `context/workflow.md`, `context/architecture.md`, `context/library-docs.md`, `context/progress-checker.md`, `specs/017-chatbot-backend-infrastructure/spec.md`, `plan.md`, `tasks.md`, `quickstart.md`, `research.md`, `data-model.md`, `contracts/api.md`, and `.specify/memory/constitution.md` where present. The Phase 8A runbook is `docs/runbooks/chatbot-handoff.md`.

## Scope

Implement only Phase 8B:

- T097: maintained dashboard/alert contract assertions in `apps/api/test/chat-handoff-observability.e2e-spec.ts` and `apps/agent/tests/test_chat_observability.py`.
- T098: 100-request router-overhead, quota-edge, handoff-latency, and consume-concurrency benchmarks; record measured p95/count evidence in `docs/runbooks/chatbot-handoff.md` and `context/progress-checker.md`.

Do not start Phase 8C, 8D, or 8E. Do not run T101 or T102. Do not remove the Next.js proxy, legacy plaintext columns, migrations, or recovery artifacts. T093 is complete according to the current progress record; preserve its evidence and do not rerun the full Playwright suite solely for these gates unless the verified workflow requires it.

## Entry gate

Confirm that:

- T093 is marked complete in `specs/017-chatbot-backend-infrastructure/tasks.md` and `context/progress-checker.md` with actual evidence already supplied by the owning session.
- T094–T096 are complete and their runbook/context validation remains green.
- Redis, API, agent, and web test prerequisites are understood from `quickstart.md`.
- Existing unrelated worktree artifacts are preserved and excluded from staging.

If the T093 evidence is not present in the repository/progress artifacts, stop and report the evidence gap rather than inventing a result. Do not modify T093 evidence from this session.

## Implementation workflow

Follow the complete Spec Kit implementation loop:

1. Run `.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` from the repository root, using `SPECIFY_FEATURE_DIRECTORY=specs/017-chatbot-backend-infrastructure` if needed. Parse absolute `FEATURE_DIR` and `AVAILABLE_DOCS`.
2. Inspect `FEATURE_DIR/checklists/`, if present. If any checklist is incomplete, show the status table and stop for explicit approval before implementation.
3. Inspect `.specify/extensions.yml`. Execute or report hooks according to the skill; after implementation, perform the mandatory `after_implement` hook check.
4. Read all required spec-kit and context files listed above. Extract T097/T098 dependencies, exact metric names/allowlists, alert thresholds, benchmark boundaries, and the no-PII/no-secret invariants.
5. Verify repository ignore files and current worktree state. Do not alter unrelated generated artifacts.
6. Use TDD for each behavioral slice: write a public-boundary failing test, run it to confirm RED, implement the smallest change, run focused tests to GREEN, refactor while green, then mark the task `[x]` only after all prior tests remain green.
7. For T097, assert the maintained dashboard/alert contract against actual emitted telemetry. Distinguish implemented metrics from required-but-not-yet-emitted panels. Do not make tests pass by claiming metrics that the runtime does not emit. If a runtime gap is discovered, add a narrowly scoped implementation task/change only if it is explicitly within T097; otherwise stop and report it.
8. For T098, use deterministic model/supplier/payment fakes and warmed requests. Measure the specified counts and p95 values, including router overhead, handoff create/resolve latency, quota edge admission, and single-winner consume concurrency. Do not invent thresholds; use the specification’s p95 `<100 ms` router overhead and `<300 ms` handoff create/resolve targets, plus exact concurrency counts from the plan.
9. Record exact commands, dates, environment assumptions, counts, p95 values, and failures/gaps in the runbook and progress tracker. Never record credentials, message content, offer IDs, database IDs, PNRs, passenger/payment data, or raw tool payloads.
10. Run targeted API/agent tests, relevant lint/type checks, and the benchmark commands. Run full Playwright only when required by the verified workflow; T098 alone does not authorize unrelated browser reruns.
11. Run `/gsd-code-review` (or the repository’s equivalent code-review skill) before completion. Review telemetry privacy, threshold correctness, deterministic fakes, concurrency isolation, test flakiness, and whether benchmarks measure the public boundary rather than implementation internals. Resolve every actionable finding, then run `/speckit-converge` if the feature artifacts need a consistency audit.
12. Run `git diff --check`, configured format/lint checks, relative-link checks, stale terminology checks, and the exact relevant test commands again after review. Verify all T097/T098 acceptance criteria against fresh output.
13. Mark T097/T098 `[x]` only when evidence is complete. Leave T099–T102 pending. Do not commit or push automatically unless the user explicitly authorizes it.

## Required review questions

- Are all dashboard panels and alert conditions tied to actual allowlisted metrics?
- Are the only specification-defined numeric thresholds preserved: error rate above 2× baseline for five minutes, handoff resolve/consume p95 above 300 ms, and router overhead p95 below 100 ms?
- Do quota and consume benchmarks prove accepted-only charging and exactly one supplier-reaching winner?
- Are benchmark fixtures deterministic, warmed, bounded, and free of secrets/PII?
- Do tests fail if message content, summaries, handoff credentials/hashes, local/provider IDs, DB IDs, PNRs, passenger/contact/passport/payment data, or raw tool payloads enter telemetry?
- Do runbook/progress records clearly separate measured evidence from operator-configured thresholds and remaining gaps?

## Completion report

Report changed files, T097/T098 status, exact commands/results, measured counts/p95 values, code-review findings and resolutions, known evidence gaps, and confirmation that Phase 8C–8E plus T101/T102 remain unstarted.
