# T093 First Signed Search Diagnosis

## Finding

The latest T093 failure is a deterministic test-database fixture problem. It is not a stochastic external-provider failure and not a new phase-4 security-gate regression.

The T093 API server replaces `DuffelService` with a deterministic SGN→HAN boundary double at `apps/api/test/t093-server.ts:154-161`; its `searchFlights` implementation returns the fixture at `:137-145`. The same helper only overrides country lookup at `:163-170`. It does not seed or replace the airport-table lookup used by canonical search.

A read-only Prisma query against the configured `test_db` returned:

```text
airports: 0
sgn: null
han: null
flightOffers: 0
searchHistories: 0
```

Canonical `FlightsService.search` checks `prisma.airport.findUnique` for both codes at `apps/api/src/flights/flights.service.ts:236-240` and throws at `:242-246` before calling `duffelService.searchFlights` at `:264`. Therefore the underlying error for this run is expected to be `Origin airport with code SGN does not exist`; `AttestedFlightSearchService.searchFlightsV2` logs only the generic `Failed to search flights V2` at `:527`, which explains the sanitized report wording.

The airport validation predates phase 4 (`git blame` points to commit `604e03e1`). There is no diff from baseline `77caeed` in `apps/api/src/flights`, `apps/api/src/agent-gateway/attested-flight-search`, or `apps/api/test/t093-server.ts`. The repository already documents the same class of fixture issue in `context/progress-checker.md:308-314`, where gateway E2E suites were corrected to seed airport rows.

## Minimal correction and retry decision

Prepare the T093 `test_db` with the existing airport reference seed before rerunning. The narrow operational correction is to run `apps/api/prisma/seed/airports.ts` with `DATABASE_URL` pointed at `test_db`; the repository's full `prisma db seed` also invokes that script through `apps/api/prisma/seed.ts`. A durable T093 harness correction should ensure the required SGN/HAN airport fixtures before the API server starts, while retaining production airport validation.

Do not retry in the current state: another run will deterministically fail before the provider boundary. After the airport fixture is present, one T093 retry is warranted because the supplier is deterministic in this harness. No source, test expectation, or database data was changed during this diagnosis.
