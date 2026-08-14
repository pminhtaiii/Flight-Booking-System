# Phase 8C implementation prompt — privacy corpus and full regression

You are continuing Feature 017, Chatbot Backend Infrastructure and Booking Handoff, after Phase 8A documentation, Phase 8B observability/performance gates, and the separately completed Phase 7D/T093 browser observation flow.

Use the named `$speckit-implement` workflow from `.agents/skills/speckit-implement/SKILL.md` for this session. Read that skill completely before acting. Also read `AGENTS.md`, `context/workflow.md`, `context/architecture.md`, `context/library-docs.md`, `context/progress-checker.md`, `specs/017-chatbot-backend-infrastructure/spec.md`, `plan.md`, `tasks.md`, `quickstart.md`, `research.md`, `data-model.md`, `contracts/api.md`, and `.specify/memory/constitution.md` where present. The operational contract is `docs/runbooks/chatbot-handoff.md`; Phase 8B evidence must already be recorded before starting.

## Scope

Implement only Phase 8C:

- T099: run the seeded negative privacy corpus across LLM fixtures, SSE, bootstrap/access logs, traces, audits, clean URLs, DOM, JavaScript-readable cookies, and browser storage; verify temporary legacy ChatMessage/title plaintext has complete ciphertext twins and recovery export with zero migrated-path exposure; record evidence in the runbook.
- T100: run full agent pytest, shared/API builds, API Jest/E2E, and Playwright regressions from `quickstart.md`; reconcile `spec.md`, `plan.md`, `data-model.md`, `contracts/api.md`, `tasks.md`, and accepted context terminology against green behavior.

Do not start Phase 8D or 8E. Do not run T101 or T102. Do not delete the proxy, plaintext columns, migrations, backups, recovery exports, or legacy compatibility artifacts. Do not claim cleanup is complete merely because the privacy corpus passes during reversible observation.

## Entry gate

Confirm that:

- T093 is marked complete with actual owning-session evidence.
- T094–T098 are complete, with fresh validation and benchmark evidence.
- The runbook and progress tracker distinguish temporary legacy plaintext inventory from approved irreversible cleanup.
- The encrypted-chat recovery export, database/backup inventory, and ciphertext backfill status are discoverable; if any required evidence is absent, stop and report the gap before destructive or irreversible work.

## Implementation workflow

Follow the complete Spec Kit implementation loop:

1. Run `.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` from the repository root, using `SPECIFY_FEATURE_DIRECTORY=specs/017-chatbot-backend-infrastructure` if needed. Parse absolute `FEATURE_DIR` and `AVAILABLE_DOCS`.
2. Inspect `FEATURE_DIR/checklists/`, if present. If any checklist is incomplete, show the status table and stop for explicit approval before implementation.
3. Inspect `.specify/extensions.yml`; follow all before/after hook instructions from the Speckit skill.
4. Read all required spec-kit and context files listed above. Build a traceability checklist for T099/T100 covering every privacy surface and every full-regression command.
5. Verify current branch/worktree state and ignore files. Preserve unrelated generated reports, logs, caches, and user changes; stage only intentional Phase 8C files.
6. Use TDD for any new privacy/regression harness behavior: write a public-boundary failing test, confirm RED, implement the narrowest fix or fixture, confirm GREEN, refactor, and keep all previous tests green. Never weaken, skip, delete, or rewrite an established test without explicit user approval.
7. Run the seeded negative corpus through each required surface. The forbidden corpus must include chat message content, summaries, handoff credentials and hashes, local/provider offer IDs, database IDs, PNRs, passenger/contact/passport data, payment data, raw tool payloads, authorization tokens, and URL-bearing leakage. Verify the only allowed transient credential locations are the strict `ACTION_HANDOFF` credential field and redacted same-origin bootstrap/HttpOnly handling.
8. Verify encrypted persistence without performing T102: every migrated ChatMessage/title row on the exercised path has a ciphertext twin, recovery export is inventoried, keys remain outside PostgreSQL/backups, and no migrated path reads or emits plaintext unexpectedly. Treat any legacy-column match as the explicitly inventoried reversible-observation exception and document it; do not drop columns.
9. Run the full regression commands from `quickstart.md`: agent pytest, shared/API/web builds, API Jest, API E2E, and the configured Playwright suite. Capture exact commands, dates, exit codes, test counts, and environment limitations. If a service or dependency is unavailable, report the failed command and blocker honestly; do not substitute a partial suite while claiming full regression.
10. Reconcile `spec.md`, `plan.md`, `data-model.md`, `contracts/api.md`, `tasks.md`, and accepted `CONTEXT.md` terminology against the actual green behavior. Remove stale claims such as proxy removed, plaintext cleanup complete, LLM creates booking, offer ID sent to LLM, or token in URL only when the source claim is factually stale and the edit stays within T099/T100 documentation scope.
11. Run `/gsd-code-review` (or the repository’s equivalent security/privacy code-review skill) before completion. Review log/trace/audit fields, browser URL/storage/cookie surfaces, access-log redaction, error messages, backup/recovery scans, encryption fallback behavior, claim/handoff privacy, and whether any test fixture accidentally introduces a real secret or personal data. Resolve every actionable finding, then run `/speckit-converge` to audit spec/plan/tasks/context consistency.
12. Run fresh `git diff --check`, configured formatting/lint/type checks, relative-link checks, stale terminology checks, privacy corpus assertions, and the exact full-regression commands again after review.
13. Mark T099/T100 `[x]` only when the complete evidence is present. Leave T101/T102 explicitly pending and approval-gated. Do not commit or push automatically unless the user explicitly authorizes it.

## Required review questions

- Does every required privacy surface have a tested negative assertion, including DOM, URLs/history, readable cookies, browser storage, SSE, logs, traces, audits, and bootstrap/access logs?
- Are credentials absent everywhere except the exact structured action field and redacted HttpOnly bootstrap path?
- Are legacy plaintext columns correctly treated as a temporary, inventoried exception rather than “cleanup complete”?
- Does the full regression report distinguish green suites from skipped/unavailable services and avoid claiming Playwright/privacy/backup evidence that did not run?
- Are spec, plan, data model, contracts, tasks, quickstart, architecture, library rules, runbook, and progress tracker consistent about T093, Phase 8A/8B/8C, the proxy rollback seam, T101, and T102?
- Did review confirm that no real credentials, user data, or sensitive provider identifiers entered fixtures, reports, logs, or committed documentation?

## Completion report

Report changed files, T099/T100 status, exact privacy and regression commands/results, test counts, skipped/blocked evidence, code-review findings and resolutions, and confirmation that Phase 8D/8E plus T101/T102 remain unstarted.
