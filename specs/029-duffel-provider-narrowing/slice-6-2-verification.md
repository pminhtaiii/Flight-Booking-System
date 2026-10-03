# Phase 6 Slice 2 — Neutral Identifiers (T047–T054)

Date: 2026-10-03. Branch: `codex/029-duffel-provider-narrowing`. Review baseline: `76145bd1b3f51965047cdd540e55f164f6ff5148`.

## Scope and approvals

This checkpoint covers T047–T054. T055–T057 and Feature 029 completion remain outside this slice; no merge is authorized.

The starting checkout was clean at the baseline. Preceding [PR #367](https://github.com/pminhtaiii/wayfinder/pull/367) is merged with successful required CI on that exact HEAD, including `ci-status`. This is verified remote evidence, separate from this slice's local and eventual remote gates.

The user approved the bounded design and supplied the installed writing-plans and subagent-driven-development skill paths. The implementation plan is `docs/superpowers/plans/2026-10-03-feature-029-neutral-identifiers.md`, committed as `48266241`. Implementation and reviews use fresh `gpt-6-luna` subagents at `max`, with no more than two feature tasks per implementer.

The user explicitly approved two existing-test adaptation proposals:

- Agent canonical fixtures/attribute access change to `supplierOfferId`; the valid legacy snapshot control becomes a neutral canonical control, and stale Duffel-only snapshots are rejected. Gateway/SSE legacy keys and other behavioral assertions stay intact.
- API/shared edits are limited to internal domain/Prisma fixture keys/property access and new-write normalized snapshot expectations. Fixture values and scenarios stay intact. HTTP/SSE keys, exact signed bytes, legacy stored JSON, webhook payloads, and persisted history literals remain unchanged.

Modified existing test files must include a comment recording this human approval and its reason. No weakening, deletion, or skipping is authorized.

T050 process correction: the worker initially authored five new cases before the first RED and changed two new SSE timestamp expectations before approval. Root interrupted immediately on disclosure. The user explicitly approved retaining `.isoformat().replace('+00:00', 'Z')` for departure/arrival expected values because existing Pydantic JSON uses `Z`; the complete display-object assertion remains. The worker must record this approval/reason and replay behavioral RED/GREEN cycles individually. This initial process deviation is not described as a compliant vertical cycle.

The final worker report additionally disclosed removal of a briefly drafted, unrun stale-handoff negative test after the corrective prompt. Tests are immutable once written even if unrun; this removal was not approved. Root kept implementation stopped and requested the exact removed source in the task report for coverage restoration under user guidance. No claim of fully compliant TDD is made.

The first full agent run exposed two additional canonical fixture sites outside the original proposal. The user separately approved changing only the internal snapshot field in `test_phase8c_privacy.py::test_project_snapshot_results_excludes_identifiers` and seeded state in `test_sse_integration.py::test_sse_action_handoff_ordering_and_schema` to `supplierOfferId`. Values, assertions, and separate HTTP/SSE fixtures remain intact.

## Environment and migration planning

The new migration path `apps/api/prisma/migrations/20260929000000_supplier_identifiers/migration.sql` was absent and sorts after the latest `20260915000000_booking_projection_versions`; no path/order conflict exists. Eleven quoted physical columns and five dependent indexes are in scope; `duffel_webhook_events` is excluded. Historical migration SQL is immutable.

PostgreSQL and Redis containers were running. `pg_isready` confirmed PostgreSQL accepts connections; planned disposable database names `feature029_slice62_fresh` and `feature029_slice62_upgrade` were unused. These checks alone are not migration proof. Migration and E2E validation must use dedicated database URLs.

Both required installed Next guide paths are absent: root and web `node_modules/next/dist/docs/`. Web changes use established app patterns, with absence reported accurately.

## Task evidence

### T049 — Web checkout boundaries

Commit: `57760555530a993f3de39791bca190dd6b3b4531`.

`isSafeHandoffCheckoutPayload` now recursively rejects `supplierOfferId` alongside `duffelOfferId`. The new public-helper regression covers root/passenger/deeper object-and-array injection for both endpoints and canonical controls. Existing search/booking public projection and trusted checkout behavior already met the task requirements, so those files required no production edit.

RED: before the denylist change, nested neutral-key injection returned true and failed the new assertion; canonical control passed. GREEN: new regression plus all three baseline web targets passed **122/122**, exit 0. Web typecheck, package lint, changed-file ESLint, and diff whitespace checks passed. Lint emitted the existing Pages-directory diagnostic.

Commands (root, except Next lint from `apps/web`):

```powershell
& './node_modules/.bin/tsx.CMD' --test apps/web/tests/supplier-identity-injection.unit.ts apps/web/lib/server/flight-search.spec.ts apps/web/lib/server/booking-management.spec.ts apps/web/tests/handoff-checkout-proxy.unit.ts
& './apps/web/node_modules/.bin/tsc.CMD' -p apps/web/tsconfig.json --noEmit
node node_modules/next/dist/bin/next lint
```

No existing test changed. Normal CI unit-runner wiring is tracked under T054; the existing web CI runs Playwright characterization while baseline Node unit tests use explicit TSX commands.

Independent task review: **Spec compliant; Task quality Approved; zero findings.** Review checked the tiny diff and named wire/public/route boundaries without rerunning passing tests.

### T050 — Agent working-tree checkpoint (blocked)

The uncommitted implementation renames canonical state to `supplierOfferId`, maps existing legacy gateway fields explicitly, rejects unsigned neutral gateway aliases, and rejects legacy/mixed snapshot identities. Redis parsing is strict; handoff creation rejects old graph-result identities before calling NestJS. Approved canonical fixture adaptations are in the working tree. T050 is not complete and its checkbox remains open.

The initial process deviations and approvals are recorded above. The corrective production replay used unchanged tests and restored only the worker's four owned production files from `57760555`: strict Redis rejection RED → canonical model GREEN; fresh public search RED → explicit legacy-to-neutral edge mapping GREEN; unsigned alias RED → rejection guard GREEN; unchanged SSE display control GREEN; canonical handoff RED → neutral graph mapping GREEN.

Focused affected cases: **377 passed, 2 pre-existing skips, 5 deselected**. The two separately approved fixture cases subsequently passed (**2/2**). Ruff check and formatting passed before those last two fixture edits; final full Ruff after them is not claimed.

Full non-Redis first run: **1,295 passed, 3 failed, 4 skipped, 12 deselected**. Two failures were the unlisted canonical fixtures subsequently approved and corrected. The third was the unchanged `test_cold_initialization_vs_warm_execution` timing assertion: `input.injection` p95 **2.818 ms** against **2.000 ms**.

One isolated full corrective retry: **1,297 passed, 1 failed, 4 skipped, 12 deselected**, 109.83 seconds. The same benchmark failed at **2.271 ms** against **2.000 ms**. No threshold, skip, or assertion was changed. No competing heavy checks ran. The repository fail-fast rule stopped further implementation/retries; user guidance is required. The worker did not commit T050 while its gate was red.

The worker confirmed these full runs set `UV_CACHE_DIR` only; it did not set `PYTHONPATH` or verify the requested Python network guard. These counts are **not guarded-test evidence**. Guarded full-suite validation is still missing. The actual reported command ran from `apps/agent`, without dependency synchronization:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.uv-cache'
uv run --no-sync pytest -p no:cacheprovider -m 'not redis_integration' -q
```

## Checkpoint status

T049 is complete and reviewed. T050 is uncommitted and blocked by the repeated timing gate; T047–T048 and T051–T054 implementation has not started. Read-only contract/schema/migration preparations are complete. No scoped convergence, final two-axis code-review, migration proof, new PR, or remote success is claimed for this slice. T055–T057 remain the subsequent slice.
