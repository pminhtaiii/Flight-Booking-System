# Research and Decision Reconciliation

**Date**: 2026-09-15. Evidence: supplied grilling records, actual API source, two initial exploration agents and a subsequent Luna exploration pass requested by the user. Decisions below fill implementation gaps; they do not reopen accepted product choices.

## 1. Payment entry point and cycles

**Decision**: Keep PaymentController in PaymentModule, inject PaymentFulfillmentSaga directly; PaymentModule imports saga module, never the reverse. Share existing PaymentMethodService via `payment/payment-methods.module.ts`.

**Rationale**: Current successful confirmation saves a consented method. Importing PaymentModule from saga would create a cycle with the controller host. AncillaryPaymentValidationService is create-payment-only and stays. Cancellation retains PaymentModule for PaymentRefundService, as the final source graph specifies.

**Alternatives**: Moving controllers changes unrelated ownership; duplicating PaymentMethodService providers obscures lifetime; a broad external-integrations module violates the recorded boundary.

The historical session's sentence “The saga calls into PaymentModule services” is superseded at the Nest module-import level by this cycle-free registration design. It means use lower-level payment capabilities, now supplied by IdempotencyModule, PaymentMethodsModule, BookingStateModule and SDK adapter modules; it does not authorize importing the controller-host PaymentModule from the saga. The original session remains historical evidence.

## 2. Actual payment behavior

**Decision**: Preserve current body/status semantics, including historical replay behavior, and the 25-second same-promise pending response. Fixing cached HTTP status fidelity is separate work; do not silently change it in extraction.

**Rationale**: `payment.controller.ts` sets 202 only for a PENDING body. `payment.service.ts` confirm/execute/background methods span the full real workflow, beyond the five-step sketch. Capture exception is not proof of failure. Authoritative succeeded continues; unknown remains recoverable; only known noncapture permits compensation. The contract specifies this matrix.

**Alternatives**: Turning every request async or simplifying timeout handling would regress existing behavior. Treating saved `responseCode` as newly authoritative would change public responses.

## 3. Idempotency atomicity

**Decision**: Preserve four-part request binding and ownership timestamp; add explicit owned checkpoint/completion operations for saga. Checkpoint and terminal cached response update atomically at completion. Every saga checkpoint/completion checks its acquisition fence.

**Rationale**: Current acquire/abandon are fenced but `updateRecoveryPoint` and `completeKey` update by key alone. Sharing a row does not make two separate writes atomic. External provider side effects cannot be rolled back by a failed ownership check; persist/recover authoritative provider facts without permitting stale request owners to replace replay state.

**Alternatives**: Separate checkpoint module creates unnecessary boundaries. Redis payment locks contradict the source decisions. Retain existing non-saga consumers without requiring a payment workflow checkpoint on their keys.

## 4. Booking lifecycle registration

**Decision**: Extract provider registration into BookingStateModule, inside booking-lifecycle/. Lifecycle remains the sole producer of booking-state events; outer transaction owners dispatch. RefundSettlementService may produce its separate `refund.settled` fact.

**Rationale**: BookingLifecycleModule imports RefundSettlementModule for recovery. Importing the whole lifecycle module from settlement creates a cycle. Registering the same lifecycle service in multiple modules is also wrong.

**Alternatives**: Letting every service invent booking transitions undermines the recorded single-owner rule. Splitting recovery into a new domain module is broader than necessary.

## 5. Event inventory versus historical examples

**Decision**: Replace all current direct calls, not a fixed count. Audit confirms nine external calls: lifecycle three, recovery four, cancellation one, supplier sync one. Cover hidden status writes in cancellation claims, refund success/failure and manual refund retry. Specify disruption mutations and nonbusiness exclusions in the event contract.

**Rationale**: Merely replacing old call sites leaves real gaps. `aggregateVersion` in the ADR log example means envelope `sourceVersion`; use one canonical field name.

**Alternatives**: Generic intent events or arbitrary `refreshProjection` events couple producer to consumer. No generic retry, outbox or queue; reconciliation is the chosen safety net.

## 6. Coherent hydration and stale writes

**Decision**: Read one consistent booking/revision snapshot; cache its promise only for the event-processing cycle. Guard writes atomically against persisted version and label the row with hydrated version. Preserve agentReference on conflicts.

**Rationale**: Event version can lag the current source. A read-then-write stale guard permits reverse completion to regress data. Conditional last-write-wins SQL needs no optimistic retry loop. A failed/malformed extraction stays stale and visible.

**Alternatives**: Global booking-ID hydration cache stales indefinitely. Timestamps are not a reliable ordering key. Advancing version while retaining an obsolete itinerary falsely declares repair.

## 7. Reconciliation and migration

**Decision**: Booking default version 1; historical projection default sourceVersion 0. LEFT JOIN detects missing and older rows. Use rotating keyset pagination, 100 candidates/pass, concurrency five, one-minute cadence, per-process overlap guard. Backfill shares safe guarded writer.

**Rationale**: Equal migration defaults conceal existing drift. A repeatedly failing first batch starves later bookings without cursor progress. Missing rows also need repair. Duplicate replica work is safe, though wasteful.

**Alternatives**: Blind rebuild and distributed leases are unnecessary now. Reconciliation has no strict global freshness guarantee under persistent DB/data failures or unbounded backlog.

## 8. Dependencies and documentation verification

No dedicated installed Nest/Prisma/Stripe/Duffel skill was found in the project skill catalog. Existing project rules in context/library-docs.md apply. No third-party code or dependency is installed by this planning task.

Nest documents root event-module initialization and declarative listeners in its [event guide](https://docs.nestjs.com/v11/techniques/events). This is version 11 documentation; verify the selected package against the repository's Nest 10 before implementation. The [event-emitter release history](https://github.com/nestjs/event-emitter/releases) distinguishes older releases; do not blindly install latest. `tasks.md` requires peer/dependency resolution and a lockfile change, not a Nest framework upgrade.

## 9. Workflow adaptation

The invoked GSD skill exists, but its referenced `~/.codex/get-shit-done/workflows/plan-review-convergence.md` and supporting references were not found; the project variant's referenced runtime was also absent. Use the user's explicit subagent convergence request directly: independent review, severity ledger, concrete revision, then re-review. Report this as adapted subagent convergence, not an external cross-model CLI run. Stop if the same substantive blocker persists after one correction, per AGENTS.md. User explicitly authorized generating plan/spec/tasks, so no repeated permission request between those artifacts.
