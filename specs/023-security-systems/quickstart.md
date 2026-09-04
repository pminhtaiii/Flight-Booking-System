# Security Validation Quickstart

**Status**: Future validation guide. Commands for new scripts/tests become runnable as the corresponding tasks are implemented. No tests/scans were run during planning.

## Prerequisites

Read `context/workflow.md`, `context/library-docs.md` and `TEST_INFRA.md` when implementing/running tests. Before Next.js changes, read installed `apps/web/node_modules/next/dist/docs/` guides. Load applicable installed library skills before introducing tools. Use subagents for implementation/review per AGENTS.md.

Require installed workspace dependencies, Docker Desktop, Python/uv and the T003 pinned scanner tools/images. Use synthetic local secrets and isolated PostgreSQL/Redis only. T007 must provision local model/supplier HTTP stubs and fail startup if provider destinations leave its allowlist; it must not copy production credentials into the stack. Keep existing service-network guards intact for unit tests.

## Existing Regression Commands

From `C:/Booking Systems` in PowerShell:

```powershell
node --test tests/ci/ci-workflow.contract.test.mjs
$env:UV_CACHE_DIR = 'C:/Booking Systems/.t093-uv-cache'
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests -m 'not redis_integration'
```

Expect final exit 0 per command; fail on unexpected skipped security cases. T001 selects existing runner, graph, output, snapshot and handoff suites from actual files. Run affected API/web/shared gates from AGENTS.md in T049, including build and relevant existing E2E suites. Any Playwright result requires the final process exit code 0, including Windows cleanup; passing assertions alone are insufficient.

## New Security Gate Commands (T003–T041 implement these interfaces)

```powershell
node scripts/security/validate-corpus.mjs
node --test tests/security/corpus-contract.test.mjs tests/security/evaluate-results.test.mjs tests/security/report-privacy.test.mjs tests/security/supply-chain.test.mjs
uv run --package agent pytest apps/agent/tests/security --cov=agent --cov-branch --cov-report=xml:artifacts/security/coverage.xml
node scripts/security/run-sast.mjs --mode full
node scripts/security/run-supply-chain.mjs
node scripts/security/run-local-dast.mjs --profile full
node scripts/security/evaluate-results.mjs --directory artifacts/security
```

The coverage evaluator applies >=95% statements/>=90% branches to changed security modules (including streaming/ASGI middleware, startup/config, tool clients/projections, memory and reused sanitizers) listed in `tests/security/coverage-policy.json`, while explicit critical-transition tests remain mandatory. The local DAST wrapper owns starting/health-checking the isolated stack, authenticating two users, invoking ZAP and pytest/Playwright drivers, collecting reports, enforcing scope/time budgets, and tearing down its own processes/data. It must not reuse the unit-test network-guard environment blindly or disable it globally. Restore child environments after each job.

`run-sast.mjs` executes pinned custom-rule fixtures before production scans and reports source counts. `run-supply-chain.mjs` runs pinned SCA and secret tools separately and captures advisory timestamps. ZAP reports and exit codes are both evaluated; default warnings never imply a clean release.

## Scenario Proofs

1. Send malicious input through SSE and controller; assert static safe rejection and zero router/model/tool calls. Repeat with absent/invalid registry, persisted history/summary injection and benign multilingual flight/greeting controls. No unsafe loaded history reaches summarization or model execution. Exercise raw-body limits with absent/false Content-Length, chunked transfer and compressed response expansion before JSON parsing.
2. Force a forbidden tool call while input passes. Assert zero downstream requests; inject malformed/PII/instruction-bearing tool results and inspect graph/state/checkpoints/model requests/public events/logs for forbidden canaries.
3. Stream each synthetic PII fixture at every split and at EOF. Assert nothing forbidden reached client bytes or persisted assistant content; cancellation discards pending data and releases leases.
4. Authenticate as user A and attempt user B session/booking/snapshot/handoff access; verify rejection, no foreign data and no transaction side effects. Test expired/revoked claims and stale fencing.
5. Run verified authenticated ZAP plus custom HTTP/SSE corpus; require exercised protected routes, complete 200+/500+ holdout counts and per-stage denominators. TPR >=95%, FPR <=2%; any authorization/privacy invariant failure blocks.
6. Seed unsafe/safe static fixtures, missing reports, scanner crash and expired exception; verify ci-status would fail appropriately, not silently skip.
7. Test audit sink outage, resource bounds and rollback; no raw payload/userId or metric-cardinality explosion, no unguarded fallback.

## Evidence and Release

Use `security-test-matrix.md` to link SEC IDs to JUnit/coverage/report records. Collect SHA, corpus/rule/tool versions, target/route manifests, counts, confusion matrices/confidence intervals, sanitized reports, findings/retests and exit codes in `docs/security/release-evidence.md`. Repeat the deterministic DAST run on the same SHA/corpus; results must agree. Keep raw captures ephemeral/restricted, publish only sanitized evidence for 30 days.

No unresolved Critical/High findings, incomplete scanners, missing matrix rows or failed invariants at release. Fix and retest; never reduce a denominator or relabel holdout cases to meet the threshold. Live-provider evaluation and production scanning require a separate scoped task and are not established by this guide.

## Reviewed Execution Details

Use the capability, detector span, corpus delivery and quota-profile contracts in `contracts/guardrail-boundaries.md`. Tool/output candidates enter through benign carrier turns; require an expected-stage marker before scoring. Auth/quota/resource assertions are separate invariant tests, not detector TPs. Default detector allocation is input 100/250, tool 50/125 and output 50/125; all denominators stay fixed.

The detector profile configures only isolated service quotas (10000/day, 600/min). A separate invariant profile uses actual defaults and verifies quota exhaustion/Redis failure. Reset only disposable run namespaces between repeats. Include setup/auth traffic in bounds; fixed disjoint shards may satisfy full coverage under per-shard 5000-request/30-minute caps. Missing shards or unexpected 429s fail. Compare repeated semantic results, not variable trace IDs, durations or alert ordering.

Before graph/model dispatch, assert trusted post-router capabilities for valid, invalid, downgraded and single-agent routes. Test maximal/overlong PII candidates and Unicode mapping; capture model callbacks, raw state export and generated summaries as well as SSE. Unsafe generated summaries never persist; untrusted history never becomes system instructions. These are mandatory T018–T026/T039 checks.
