# Research: Cancellation & Refund Recovery

## Decisions

### Supplier-first cancellation

**Decision:** Confirm the supplier cancellation before starting a Stripe refund.

**Rationale:** The flight/PNR must be released before money is returned. A local
state transition alone is not proof that the supplier accepted the cancellation.

**Alternatives considered:** Refunding first risks returning funds while a live
order remains. A single background-only workflow makes a deadline-sensitive
cancellation appear accepted when it is not.

### Optimistic claims, not long database locks

**Decision:** Use conditional `updateMany` transitions as compare-and-swap (CAS)
claims for cancellation, reconciliation, and refund attempts.

**Rationale:** Remote Duffel and Stripe calls may be slow. Holding a database
transaction open across them increases lock contention and still cannot make the
external calls atomic.

### Two-tier retry policy

**Decision:** Retry supplier cancellation inline at 1, 3, 5, and 10 seconds;
retry Stripe refunds inline at 1, 3, and 5 seconds and then with a scheduled
worker at 1 minute, 5 minutes, 30 minutes, and 2 hours.

**Rationale:** Supplier cancellation is deadline-sensitive, while a successful
supplier cancellation must not leave a customer without a refund if Stripe is
temporarily unavailable.

### Remote-first crash recovery

**Decision:** On a claimed cancellation retry, retrieve the Duffel order first;
reuse an unconfirmed quote when possible; only create a new quote when none
exists and the order is not already cancelled.

**Rationale:** This closes the gap in which an upstream call succeeds but the
local database write crashes.

### Refund idempotency expiry

**Decision:** Reuse one Stripe refund idempotency key per logical refund. Do not
retry after the key is 22 hours old; escalate for manual attention instead.

**Rationale:** Stripe idempotency keys expire after 24 hours. Retrying after the
safety margin could create a duplicate reimbursement.

### Failure classification

**Decision:** Retry only transient Stripe failures (5xx, timeout, 429,
connection reset). Escalate deterministic failures immediately.

**Rationale:** Retrying a declined, disputed, invalid, or already-refunded
charge cannot repair it and delays a human resolution.
