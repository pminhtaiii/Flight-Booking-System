# Quickstart Validation Guide: Feature 019

This guide validates the architecture slices after implementation. Run each focused gate before the full regression gate. Commands assume PowerShell at the repository root.

## Prerequisites

```powershell
docker compose up -d

Push-Location apps/api
& '.\node_modules\.bin\prisma.CMD' generate
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\node_modules\.bin\prisma.CMD' migrate status
Pop-Location
```

Required local configuration remains the existing test configuration. Do not use live Stripe or Duffel credentials.

## Gate 1: Refund data migration and settlement

Run the migration/backfill verification against a disposable test database, then execute focused refund suites:

```powershell
Push-Location apps/api
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/refund-settlement/refund-settlement.service.spec.ts `
  src/refund/refund-transaction.service.spec.ts `
  src/payment/payment-refund.service.spec.ts `
  src/payment/payment-webhook.service.spec.ts `
  src/payment/payment-cron.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand `
  test/payment-refund.e2e-spec.ts `
  test/cancellation.e2e-spec.ts
Pop-Location
```

Expected outcomes:

- Multiple independent transactions can fulfill one obligation.
- Concurrent reservations cannot exceed Payment or obligation capacity.
- Replay through webhook/inline/cron/admin produces one ledger pair.
- Partial obligation fulfillment projects `CANCELLED_PENDING_REFUND`.
- Full obligation fulfillment projects `CANCELLED_AND_REFUNDED`; Payment may remain `PARTIALLY_REFUNDED`.

## Gate 2: Booking module split

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/booking-lifecycle/booking-lifecycle.service.spec.ts `
  src/booking-lifecycle/booking-recovery.service.spec.ts `
  src/booking-management/booking-management.service.spec.ts `
  src/cancellation/cancellation.service.spec.ts `
  src/payment/payment.service.spec.ts `
  src/disruption/sync/reconciliation.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand `
  test/payment.e2e-spec.ts `
  test/booking.e2e-spec.ts `
  test/cancellation.e2e-spec.ts `
  test/disruption.e2e-spec.ts
Pop-Location
```

Static dependency gate:

```powershell
rg -n "forwardRef\(\(\) => (BookingModule|PaymentModule)\)|private readonly bookingService: BookingService" `
  apps/api/src/payment apps/api/src/booking apps/api/src/booking-lifecycle apps/api/src/cancellation
```

Expected: no Payment↔Booking cycle and no broad BookingService dependency.

## Gate 3: Trusted Search Snapshot lifecycle

```powershell
Push-Location apps/agent
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
uv run pytest -q `
  tests/test_trusted_snapshot.py `
  tests/test_search_snapshot.py `
  tests/test_checkout_signal.py `
  tests/test_checkout_gate.py `
  tests/test_handoff_nodes.py
Pop-Location
```

Expected: atomic version replacement, fail-closed security fields, consistent selection validation, and identifier-free projections.

## Gate 4: Chat Turn Runner

```powershell
Push-Location apps/agent
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
uv run pytest -q `
  tests/test_event_contracts.py `
  tests/test_streaming_foundation.py `
  tests/test_streaming_agent.py `
  tests/test_sse_integration.py `
  tests/test_sse_output_guardrail.py `
  tests/test_stream_session_control.py `
  tests/test_direct_stream.py
Pop-Location
```

Expected: byte-compatible typed events, cleanup before terminal errors, and no leaked lease/background task after disconnect or cancellation.

## Gate 5: Flight Search and Booking Management server seams

```powershell
& '.\node_modules\.bin\tsx.CMD' --test `
  apps/web/lib/server/flight-search.spec.ts `
  apps/web/lib/server/booking-management.spec.ts

Push-Location apps/web
$env:NEXTAUTH_SECRET = 'local-build-only'
$env:NEXTAUTH_URL = 'http://localhost:3000'
$env:API_URL = 'http://127.0.0.1:3001'
& '.\node_modules\.bin\tsc.CMD' --noEmit
node node_modules/next/dist/bin/next build
Pop-Location

& '.\apps\web\node_modules\.bin\playwright.CMD' test `
  'apps/web/tests/checkout-foundation.spec.ts' `
  'apps/web/tests/bookings.spec.ts' `
  'apps/web/tests/disruptions.spec.ts' `
  --config='apps/web/tests/playwright.config.ts' `
  --reporter=line
```

Scoped static credential/transport gate:

```powershell
rg -n "accessToken|Authorization|NEXT_PUBLIC_API_URL" `
  apps/web/app/search `
  apps/web/components/search `
  apps/web/app/bookings `
  apps/web/components/bookings
```

Expected: no matches in the accepted rendering scope; server-only modules and same-origin handlers are intentionally outside that scope.

## Gate 6: Agent Gateway capability modules

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts `
  src/agent-gateway/booking-readiness/agent-booking-readiness.service.spec.ts `
  src/agent-gateway/safe-booking-read/safe-booking-read.service.spec.ts `
  src/agent-gateway/traveler-preferences/traveler-preferences.service.spec.ts `
  src/agent-gateway/audit/agent-tool-audit.service.spec.ts

& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand `
  test/agent-gateway.e2e-spec.ts `
  test/agent-gateway-polish.e2e-spec.ts `
  test/agent-chat-gateway.e2e-spec.ts
Pop-Location
```

Expected: unchanged endpoint contracts and privacy projections, no raw DTO audit metadata, and no controller depending on the broad AgentGatewayService.

## Full regression gate

```powershell
pnpm build
pnpm lint
pnpm test

Push-Location apps/agent
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
uv run ruff check .
uv run pytest -q
Pop-Location

Push-Location apps/api
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\node_modules\.bin\jest.CMD' --config ./test/jest-e2e.json --runInBand
Pop-Location
```

Because Feature 019 changes database schema, payment/booking paths, and cross-module architecture, completion also requires the real T093 flow from `AGENTS.md` to finish with Playwright exit code `0` before compatibility helpers are deleted.
