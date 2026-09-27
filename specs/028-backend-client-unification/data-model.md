# Data Model: Backend Client Unification

No persistent entity, schema, or migration changes. All values are per request.

| Concept | Fields / relationship | Invariant |
|---|---|---|
| RequestOpts | Method, headers/body, no-store cache behavior, optional `responseMode: 'json' | 'none'` | GET is retry-eligible; mutations are single-attempt; explicit none mode ignores a success body. |
| TokenProvider | Async function returning token or null | Default uses current session extraction; injected provider permits another caller. Null stops before fetch. |
| TransportResult<T> | `{ ok: true, data: T }`, HTTP failure with status/body, or transport failure with safe cause code | JSON success passes supplied schema; none-mode success yields validated void; malformed error body retains HTTP status. |
| Domain outcome | Existing flight, booking, or dashboard success/failure union | Caller maps status/cause and preserves its current wording, retryable flag, and view shape. |
| Booking route response | Existing NextResponse representation of BookingManagementOutcome | Only booking route adapter owns this mapping; six handlers use it. |

**Transitions**: Acquire token → issue request within timeout/deadline → retry only eligible GET transient failure → retain non-2xx HTTP status while optionally parsing its body → parse and validate JSON success or return void for explicit none mode → return transport result → domain mapping → optional booking route response mapping.
