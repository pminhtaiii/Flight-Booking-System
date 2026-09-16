# Payment fulfillment contract

Status: implementation contract; no runtime change has been made. Sources: the payment grilling decisions and `apps/api/src/payment/payment.service.ts`, `payment-idempotency.service.ts`, `payment.controller.ts`, `common/stripe.service.ts`, and `duffel/duffel.service.ts`.

## Ownership and dependencies

`PaymentFulfillmentSaga` owns `confirmPayment`, `executeConfirmPayment`, `handleBackgroundError`, and confirmation-only orchestration helpers. `PaymentService` retains creation/status, amount/reservation helpers, and ancillary creation validation. Provider redaction, enrichment and snapshot mapping belong beside the Duffel adapter. No raw SDK response or SDK type crosses a port.

PaymentModule hosts PaymentController and imports PaymentFulfillmentModule. The saga module must never import PaymentModule. Register the existing PaymentMethodService exactly once in `payment/payment-methods.module.ts`; both modules import that module. Preserve nonfatal post-capture saved-method synchronization and existing consent behavior. Stripe adapter is `common/stripe-payment.adapter.ts`; Duffel adapter is `duffel/duffel-fulfillment.adapter.ts`. Existing SDK modules export dependency-injection tokens bound to these adapters. Port files contain dependency-free types/tokens and import no Nest module.

IdempotencyModule owns the existing service and decorator. AncillariesModule imports it directly. Cancellation keeps its refund dependency on PaymentModule. Recovery continues using StripeService and DuffelService directly. The saga calls BookingLifecycleService through BookingStateModule after the projection split; lifecycle never calls the saga.

## Provider-blind port requirements

The following signatures specify required information, not production declarations. Define concrete value types during implementation using the existing validated passenger and shared snapshot fields. Do not use `any`, SDK classes, arbitrary provider dictionaries, or raw passenger database rows as port types.

| Operation | Input | Normalized output / failure |
|---|---|---|
| PaymentGatewayPort.authorizeHold | Existing payment intent identifier | Authorization evidence: `authorized` (requires_capture), `captured` (succeeded), `voided` (canceled), or `nonfinal`/`invalid`; no new authorization is created |
| PaymentGatewayPort.capturePayment | Intent identifier and required capture idempotency key | Capture success; a thrown/unavailable response does **not** establish noncapture |
| PaymentGatewayPort.voidHold | Intent identifier | Confirmed hold-release outcome or failure; never infer release from invocation alone |
| FulfillmentGatewayPort.createOrder | Offer identifier, validated ephemeral passengers, optional aggregated services `{ serviceId, quantity }`, operation metadata `{ bookingIntentId, paymentId }`, required order idempotency key | Order identifier, booking reference, and typed privacy-safe persisted order evidence sufficient for current checkpoint recovery |
| FulfillmentGatewayPort.cancelOrder | Order identifier | Confirmed cancellation outcome or failure |
| FulfillmentGatewayPort.retrieveOrderSnapshot | Order identifier plus typed fallback evidence, authoritative passenger enrichment fields and owner contact email | Shared FlightSnapshot, PassengerSnapshot and optional departure time; implementation retrieves complete order then applies existing fallback enrichment/mapping |

The same authorization read is used after capture exceptions and by the saga's background handler. Translate status vocabulary at the Stripe boundary, retaining enough evidence to distinguish authoritative noncapture from unavailable/nonfinal evidence. Invalid authorization retains the existing HTTP error mapping; do not expose SDK response objects.

Each port operation also requires private invocation control `{ beforeInvoke: () => Promise<void> }`, supplied by the saga as its assertOwned closure. The adapter calls it after admission and immediately before invoking the SDK; rejection releases its permit and makes no SDK call. This control is separate from provider inputs, never serialized, and knows no provider or idempotency implementation details. Contract tests prohibit omitting it on saga calls. Recovery uses SDK wrappers directly and does not supply this control.

Duffel adapter translates `serviceId` to SDK `id` and normalized operation metadata to the existing wrapper arguments. Preserve supplier idempotency key exactly; preserve capture key `${idempotencyKey}-stripe-capture`. Existing provider deadlines, caching and budget controls remain in SDK wrappers. Existing redacted payment-event metadata is still readable: adapter mapping converts legacy `id`/`booking_reference` evidence to normalized fields and serializes compatible evidence for new writes. Existing HTTP `duffelOrderId` is mapped at the response boundary; provider-blind internal types do not rename that public field.

Passenger values remain ephemeral. Never persist the complete provider response or enrichment email in a payment event. The fallback must preserve current snapshot extraction behavior, including failed-booking snapshots where possible, without widening the existing audit/log privacy surface.

## Admission and deadlines

Each adapter owns bounded local admission: Stripe 20 active calls, Duffel 10, 100 waiters each, five-second maximum admission wait. Validate configured positive bounded integers. Remove timed-out waiters and release acquired permits in `finally`, including SDK rejection. Overflow/timeout guarantees that operation has not called the provider. It does not establish an earlier operation's outcome. Apply admission to all saga port calls, including its capture-status checks and compensation. BookingRecoveryService remains on direct StripeService/DuffelService wrappers with their existing budgets/deadlines; do not route that independent recovery workflow through saga ports. Preserve existing SDK execution deadlines; no new automatic retry policy. This is process-local concurrency limiting, not a fleet rate limit or queue-backed payment workflow.

## HTTP compatibility

Keep `POST /bookings/payment/confirm`, JwtAuthGuard, ConfirmPaymentDto, required Idempotency-Key header and authenticated user ownership. Preserve current external API prefix, errors and DTO validation. Saga validates payment owner and any supplied booking owner before provider work. Retain `/api/bookings/payment/confirm` as idempotency request scope.

| Existing outcome | Required behavior |
|---|---|
| Immediate success | 200; `success`, `paymentId`, `status: SUCCEEDED`, `bookingReference`, `duffelOrderId` unchanged |
| Work exceeds 25 seconds | 202; existing `status: PENDING`, message, and `/api/bookings/payment/{paymentId}/status` pollUrl |
| First execution rejects | Preserve current HttpException status/body, including final passenger validation codes |
| Cached replay or reconstructed completed failure | Preserve current returned body/controller status behavior; stored responseCode currently does not control replay HTTP status |

Characterize the replay-status asymmetry before extraction and retain it. Correcting replay HTTP status is deferred and must not be slipped into this refactor. Preserve payment-status ownership and response shape.

The 25-second timer does not cancel or restart execution. The same promise continues and invokes background recovery if it rejects after handoff. Preserve background error logging and recovery semantics. Test both success and failure after handoff with controlled timers; no message queue or detached second confirmation is introduced.

## Idempotency and checkpoint ownership

Preserve the service's existing four-argument `acquireOrReplay(key, hash, userId, requestPath)`, deterministic hashing, customer/route scope rejection, changed-payload 422, active-request 409, five-minute stale-lock CAS, P2002 acquisition race handling, 24-hour expiry creation, getResumePoint/isLocked, and owner-fenced abandonAcquiredKey. Acquisition returns `lockedAt`; retain it for the entire execution, including the Tier 2 background handler. Never reacquire a lease merely to write that handler's checkpoint.

Every **saga** checkpoint write and terminal completion predicates on key, customer, path, request hash, acquired lockedAt and absence of a completed response. Provide `assertOwned(ownership)` using that full predicate; invoke it immediately before each authorizeHold, createOrder, capturePayment, voidHold, cancelOrder and retrieveOrderSnapshot call, including foreground/background compensation and capture-status checks. When adapter admission waits, repeat the assertion after permit acquisition immediately before the SDK call via a private admission preflight callback (not an event or provider data field). This closes the known takeover-during-wait gap without holding database locks across network calls.

Zero matched/affected rows means lost ownership: stop subsequent mutations/provider calls, do not overwrite the new owner's checkpoint/cache, and surface a recoverable conflict. Cron clearing or deleting the key invalidates the old ownership identically. Never substitute key-only getResumePoint/isLocked for this assertion. Tests take over/clear the lease before each named operation and during admission, for foreground and post-25-second execution. A database preflight cannot cancel an already-started remote call or exclude a takeover immediately afterward; preserve stable provider idempotency, payment locking and authoritative recovery for that race. Do not claim a distributed lock spans the provider call.

Checkpoints stay `started → stripe_authorized → duffel_order_created → captured → completed`. Resume uses persisted order evidence and immutable payment binding. An old worker must not regress a newer checkpoint. Within its lease, permit only forward advancement or a same-stage no-op; `captured` background advancement is allowed after authoritative capture evidence. Terminal completion stores `recoveryPoint: completed`, responseCode, responseBody and clears lockedAt in **one atomic owner-fenced update**. Remove saga's separate completed/checkpoint and cache calls. Completed-without-response legacy rows retain their existing reconstruction path.

Keep non-saga creation, refund and ancillary callers compatible: their existing completeKey semantics need not imply saga `completed`, and their existing argument lists remain valid. Introduce explicitly fenced saga operations or an explicit ownership argument; do not silently weaken fencing by making saga ownership optional. Move all consumer/decorator imports and preserve standalone idempotency tests.

## State and transaction invariants

Authorization validation precedes final passenger validation, airline order creation, capture and canonical confirmation. Never replace payment-bound ancillary selection version N with the booking intent's current version N+1. Recheck selection ID/version and PAYMENT_BOUND status immediately before provider order creation; aggregate seats/baggage quantities as currently implemented. Preserve final validator trace/correlation metadata and safe audit records.

Retain the existing transactional bundles:

- Authorization: payment status and authorization PaymentEvent together.
- Successful post-capture: Payment SUCCEEDED, captured PaymentEvent, BookingIntent CONFIRMED, canonical Booking confirmation and balanced debit/credit ledger pair together.
- Failed fulfillment/compensation: Payment cancellation, cancellation PaymentEvent, next BookingIntent status and canonical Booking failure together.

Retrieve/enrich supplier snapshots before entering a database transaction; no provider wait while holding financial database locks. Retain payment-state transition checks and PostgreSQL locking; no Redis payment lock. Payment CANCELLED and Booking FAILED are distinct states. Failed payment attempts remain terminal; a new attempt creates a new payment and existing accounting still permits at most two per intent. Preserve the existing narrow correction of Booking FAILED to CONFIRMED when already-captured payment plus airline order supplies authoritative evidence, as specified in booking-events.md; this is recovery of the existing transaction, not an in-place payment retry. Retain financial audit behavior and nonfatal payment-method synchronization. Projection integration later passes transaction/event context into lifecycle; only the outer transaction owner flushes events after commit, never within these bundles.

## Outcome and compensation matrix

| Evidence | Required action |
|---|---|
| Passenger validation/order creation fails before capture | Preserve existing hold-void compensation and failure transition/response behavior |
| Capture call throws, subsequent authoritative state is captured | Continue post-capture; never cancel order or release a captured payment |
| Capture call throws, authoritative state is authorized or voided | Attempt airline cancellation and hold release, then existing failure bundle |
| Capture state read unavailable or nonfinal | Leave PROCESSING/checkpoint/order recoverable; never infer noncapture or compensate destructively |
| Background handler observes captured | Preserve/advance captured checkpoint under its lease; leave post-capture recovery available |
| Database/audit failure after capture | No destructive compensation of captured transaction; resume from durable evidence |
| Compensation itself fails | Preserve existing safe logging and current public response parity; do not assert in telemetry that attempted compensation succeeded |

Existing public failure text can overstate compensation success. Characterize and retain it for this refactor; truthful response redesign is deferred. Recovery still has direct provider access. Unknown external outcomes never become authoritative failure because an adapter queue/admission attempt timed out.

## Verification obligations

Split existing payment.service and ancillary confirmation tests into saga-owned suites without losing create-payment coverage. Preserve `payment-ancillary-order-recovery.spec.ts` cases for immutable version N, binding recheck, supplier failure, capture failure, capture timeout-after-success, unknown reconciliation, background binding, and idempotent crash recovery. Preserve payment-state-machine, idempotency, recovery, Stripe/Duffel and refund/webhook/cron suites.

Add real controller characterization for immediate, first-failure, replay, legacy-completed and Tier 2 behavior. Add adapter argument/normalization/fallback/admission tests, every-checkpoint resume tests, and lost-lease foreground/background tests. Real PostgreSQL tests must prove stale owners cannot advance/complete a key, atomic terminal cache/checkpoint persistence, and financial transaction rollback. Compile/init actual Nest modules to prove single PaymentMethodService registration and absence of saga/PaymentModule cycles. Runtime validation results belong to implementation; this document is not evidence that tests passed.
