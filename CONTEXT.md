# Flight Booking System

Core domain language and glossary for the Flight Booking System.

## Language

**Cancellation**:
The process of terminating a confirmed flight booking. Must ALWAYS be executed Supplier-First (Duffel API) to secure the release of the PNR before any financial reimbursement (Stripe) is attempted.
_Avoid_: Revocation, Undo

**Cancellation Pending**:
A transient claim state where a process has atomically claimed a booking for cancellation (via CAS update), but the supplier cancellation has not yet been attempted or confirmed. Exists to prevent concurrent cancellation attempts from racing.
_Avoid_: Cancelling, Cancel Queued

**Refund Pending**:
A transient state (`CANCELLED_PENDING_REFUND`) where the flight has been successfully cancelled with the supplier, but the financial reimbursement has not yet been confirmed by the payment gateway.

**Refund Escalation**:
The hybrid process of attempting a Stripe refund with inline retries, falling back to a cron-based background worker with exponential backoff, and finally escalating to manual admin review (`REFUND_FAILED_NEEDS_ATTENTION`) if all retries are exhausted or the idempotency key expires.

**Cancellation Deadline**:
The fare-specific cutoff time before which a booking may be cancelled for a refund. Derived from Duffel's fare conditions at booking time and stored on the Booking row. Not a system-wide constant — varies by fare class.
_Avoid_: Cancellation Window, Refund Deadline
