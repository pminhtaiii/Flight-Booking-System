# T007 implementation plan

Scope authorized by GOAL.md: disposable stack, local stubs, two-user authentication, bounded local transport, dual quota profiles and guaranteed owned-state cleanup.

1. Add failing lifecycle tests in `tests/security/run-local-dast.test.mjs`; assert unique project names, fixed destinations, profile limits, migrations before app startup, authenticated distinct identities, and cleanup on partial startup/auth failure.
2. Implement `scripts/security/run-local-dast.mjs` with a shell-free Docker command boundary, bounded child lifetime, AbortSignal handling, fixed Compose path and sanitized summary. Expose `createRunPlan` and `runLocalDast`; never accept arbitrary project names or destructive paths from CLI.
3. Independently test and implement `dast-transport.mjs` through real loopback HTTP servers: scope refusal, redirects, request/time ceilings, bounded response bodies and pacing. Use the same transport for readiness/auth/probes.
4. Independently test and implement `compose.security.yml`, Docker build recipes and deterministic stubs. Runtime services use only an internal Docker network, explicit synthetic environment and run-owned volumes. Builds may fetch public dependencies before the runtime starts.
5. Exercise both quota profiles using explicit `--smoke`. Fresh project volumes, users, mock counters and services for every suite/profile; no production reset endpoints or shared state.
6. Run focused Node tests, CLI help, Compose validation and live disposable-stack smoke where prerequisites permit. Record infrastructure failures distinctly from detector outcomes. Full scanner execution remains T037–T041 and must fail clearly until those drivers exist.
7. Update the task checklist and relevant context with measured evidence. Per-task reviews omitted per user instruction.
