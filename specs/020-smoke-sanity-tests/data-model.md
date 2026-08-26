# Operational Model: Whole-Stack Smoke and Sanity CI

This feature adds no Prisma models, migrations, or persistent production data. The following in-memory and run-scoped concepts define the harness design.

## StackRun

Represents one complete execution.

| Field | Type | Rules |
|---|---|---|
| `runId` | string | Unique, safe for log correlation; contains no user data |
| `mode` | `ci \| local` | Controls database safety and cleanup policy |
| `startedAt` | timestamp | UTC |
| `databaseName` | string | CI job-owned name or exactly `smoke_test` locally |
| `processes` | ProcessHandle[] | Mock, API, Agent, Web only |
| `logDirectory` | path | Run-scoped and excluded from secrets |
| `phase` | enum | `BOOTING → READY → SMOKE → SANITY → CLEANUP → COMPLETE/FAILED` |
| `failure` | sanitized error? | No tokens, passwords, PII, or provider payloads |

### State transitions

```text
BOOTING → READY → SMOKE → SANITY → CLEANUP → COMPLETE
    └──── failure ───────────────→ CLEANUP → FAILED
READY timeout ──────────────────→ CLEANUP → FAILED
signal/cancel ──────────────────→ CLEANUP → FAILED
```

Sanity is reachable only from a successful SMOKE state. Cleanup is mandatory from every terminal path.

## ServiceProbe

| Field | Type | Rules |
|---|---|---|
| `name` | string | Stable diagnostic label |
| `url` | URL | Loopback only in smoke/sanity runs |
| `validate` | function | Validates status and minimal public body contract |
| `intervalMs` | number | Exactly 2000 |
| `deadlineMs` | number | Shared overall deadline, 120000 |
| `attempts` | number | Monotonic |
| `lastStatus` | number? | HTTP status only |
| `lastError` | string? | Sanitized transport/validation summary |
| `elapsedMs` | number | From shared readiness start |

All probes run concurrently. One ready probe does not wait for or serialize another probe.

## MockRouteContract

| Field | Type | Rules |
|---|---|---|
| `method` | HTTP method | Part of the route key |
| `pathnamePattern` | string/pattern | Query strings are parsed separately |
| `contentType` | JSON or form | Duffel JSON; Stripe form-encoded |
| `validateRequest` | function | Rejects missing or invalid required fields |
| `buildResponse` | function | Deterministic fixture; no random business values |
| `requestCount` | integer | Resettable, non-negative |
| `safeLog` | record | Timestamp, method, pathname, status only |

Unknown method/path combinations return 404. Malformed or contract-invalid known requests return 400/422 with a sanitized explanation. Control routes bind to loopback and expose counters only, never raw bodies or headers.

## TestActor

| Field | Type | Rules |
|---|---|---|
| `email` | string | Unique per run |
| `password` | string | Valid generated value; never logged |
| `userId` | UUID | From register/login response |
| `token` | string | Held in memory only; never logged |
| `profileId` | UUID? | Created by profile setup |
| `profileRevision` | integer? | Used for readiness/intent optimistic contract |
| `flightId` | UUID? | Public persisted flight identifier |
| `offerPassengerId` | string? | Obtained from flight detail, never guessed |
| `intentId` | UUID? | Booking intent public identifier |
| `paymentId` | UUID/string? | Public API identifier held in memory |
| `bookingId` | UUID? | Client-generated idempotent booking identity |

The actor exists only for one ephemeral StackRun. Helpers redact credentials and passenger details from diagnostics.

## SearchObservation

| Field | Type | Rules |
|---|---|---|
| `results` | public flight array | Must satisfy required field contract |
| `searchHash` | string | Equal across identical requests |
| `cached` | boolean | false on first accepted request, true on second |
| `duffelRequestCount` | integer | Exactly one after both searches |

Full response envelopes are not identical because `cached` intentionally changes.

## Relationships

```text
StackRun 1 ── owns ── * ProcessHandle
StackRun 1 ── waits on ── * ServiceProbe
StackRun 1 ── creates ── 1 TestActor
MockRouteContract * ── records ── 1 StackRun request counters
TestActor 1 ── produces ── 1 SearchObservation
```

## Persistence and cleanup

- Production schema: unchanged.
- CI Postgres/Redis: job-scoped and removed with Compose teardown.
- Local Postgres: only `smoke_test` may be reset by the harness.
- Logs: run-scoped, sanitized, retained in CI output or temporary diagnostic directory.
- Mock counters and actor credentials: memory-only.
