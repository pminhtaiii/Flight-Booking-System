# Quickstart: Validate the Authenticated Booking Dashboard

## Prerequisites

- Node.js 20+, pnpm 9+, installed dependencies and PostgreSQL through Docker Compose.
- Matching JWT/NextAuth settings and a representative test user/booking fixture.

## 1. Start dependencies and prepare Prisma

```powershell
docker compose up -d
Push-Location apps/api
& '.\node_modules\.bin\prisma.CMD' generate
$env:DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/test_db'
& '.\node_modules\.bin\prisma.CMD' migrate status
Pop-Location
```

Expected: services are healthy and no dashboard migration exists.

## 2. Run shared contract and API tests

```powershell
pnpm --filter @shared/types build
node --test packages/shared/dist/types/dashboard.types.spec.js

Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/dashboard/dashboard.service.spec.ts `
  src/dashboard/dashboard.controller.spec.ts
& '.\node_modules\.bin\jest.CMD' --config test/jest-e2e.json --runInBand test/dashboard.e2e-spec.ts
Pop-Location
```

Expected: metric, tenant, ordering, allowlisting, auth and contract tests pass.

## 3. Run web boundary and UI tests

```powershell
& '.\node_modules\.bin\tsx.CMD' --test apps/web/lib/server/dashboard.spec.ts
pnpm --filter @api/backend build
& '.\apps\web\node_modules\.bin\playwright.CMD' test `
  'apps/web/tests/dashboard.spec.ts' `
  --config='apps/web/tests/playwright.config.ts' `
  --reporter=line
```

Expected: `dashboard.spec.ts` starts and stops its own local port-3101 summary fixture for Server Component requests; populated/empty/error states, routing, actions, recent links and responsive behavior pass with exit code 0.

## 4. Run static and production gates

```powershell
pnpm exec eslint "apps/api/**/*.ts" "apps/web/**/*.{ts,tsx}" "packages/shared/**/*.ts" --max-warnings 0
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @web/frontend typecheck
Push-Location apps/web
$env:NEXTAUTH_SECRET = 'local-build-only'
$env:NEXTAUTH_URL = 'http://localhost:3000'
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:3001'
node node_modules/next/dist/bin/next build
Pop-Location
```

Expected: all commands exit 0.

## 5. Manual acceptance walkthrough

1. Signed-out `/` shows marketing; signed-in `/` redirects to `/dashboard`.
2. Verify Total, Upcoming, Completed and Cancelled cards and at most five recent owner bookings.
3. Verify no Disruption Shield percentage, fake insight claim, prototype banner/switcher or prototype-only link.
4. Exercise quick search, actions and recent detail links.
5. Run with `NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS=false` and confirm no Profile action is rendered; repeat with `true` and confirm Profile reaches the live `/profile` workspace.
6. Check 360 px, 768 px and desktop layouts plus keyboard focus.
7. Stop the API and confirm a safe retry state with no fabricated counts.

See [dashboard-summary.openapi.yaml](contracts/dashboard-summary.openapi.yaml) and [data-model.md](data-model.md).
