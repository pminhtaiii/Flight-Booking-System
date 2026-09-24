# Quickstart: Validate Backend Client Unification

Run from repository root in PowerShell with dependencies already installed. Focused tests use fake fetch/session providers and need no backend service. See [client contract](./contracts/backend-client.md) for the retry matrix.

## Focused steps

```powershell
& '.\node_modules\.bin\tsx.CMD' --test `
  apps/web/lib/server/backend-client.spec.ts `
  apps/web/lib/server/dashboard.spec.ts `
  apps/web/lib/server/flight-search.spec.ts `
  apps/web/lib/server/booking-management.spec.ts `
  apps/web/lib/server/outcome-response.spec.ts `
  apps/web/app/api/booking-management/route-parity.spec.ts `
  'apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/route.spec.ts' `
  'apps/web/app/api/booking-management/bookings/[bookingId]/cancellation/quote/route.spec.ts'
```

`backend-client.spec.ts` is created during implementation. Expected: exit code 0; GET retry matrix, no mutation replay, missing-token short circuit, dashboard INVALID_RESPONSE, booking error-body forwarding, and route mapping parity all pass.

## Final gate

```powershell
pnpm --filter @web/frontend lint
pnpm --filter @web/frontend typecheck
pnpm --filter @web/frontend build
rg -n 'function (apiUrl|getAccessToken|fetchWithRetry|mapOutcomeToResponse)' apps/web/lib/server apps/web/app/api/booking-management
```

Expected: lint, typecheck, and build exit 0. Review the ripgrep census: the in-scope URL/token/retry helpers live only in `backend-client.ts`, and response mapping lives only in `outcome-response.ts`. Confirm no Prisma, lockfile, endpoint, or feature-flag diff.
