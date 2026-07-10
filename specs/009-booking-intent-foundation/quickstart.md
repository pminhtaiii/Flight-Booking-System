# Quickstart: Booking Intent Foundation
**Feature**: 009-booking-intent-foundation
**Date**: 2026-07-10
---
## Prerequisites
1. Docker services running (`docker compose up -d`)
2. Database migrated (`npx prisma migrate dev --schema=apps/api/prisma/schema.prisma`)
3. API server running (`pnpm --filter @api/backend dev`)
4. A registered user with a valid JWT token
5. At least one flight search completed (so `FlightOffer` rows exist in the database)
---
## Validation Scenarios
### Scenario 1: Create a Booking Intent
**Purpose**: Verify end-to-end intent creation with Duffel re-pricing.
```bash
# 1. Login to get JWT token
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPassword123!"}' | jq -r '.accessToken')
# 2. Search for flights (to get a FlightOffer ID)
SEARCH=$(curl -s -X POST http://localhost:3001/flights/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"origin":"SGN","destination":"NRT","departureDate":"2026-08-15","adults":2}')
OFFER_ID=$(echo $SEARCH | jq -r '.offers[0].id')
DUFFEL_OFFER_ID=$(echo $SEARCH | jq -r '.offers[0].duffelOfferId')
# 3. Create booking intent
curl -s -X POST http://localhost:3001/bookings/intent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"flightOfferId\": \"$OFFER_ID\",
    \"duffelOfferId\": \"$DUFFEL_OFFER_ID\",
    \"passengers\": [
      {
        \"type\": \"ADULT\",
        \"givenName\": \"John\",
        \"familyName\": \"Doe\",
        \"dateOfBirth\": \"1990-05-15\",
        \"gender\": \"male\",
        \"nationality\": \"US\",
        \"passportNumber\": \"X12345678\",
        \"passportExpiry\": \"2030-01-01\",
        \"useProfile\": true
      },
      {
        \"type\": \"ADULT\",
        \"givenName\": \"Jane\",
        \"familyName\": \"Doe\",
        \"dateOfBirth\": \"1992-08-20\",
        \"gender\": \"female\",
        \"nationality\": \"US\",
        \"passportNumber\": \"Y87654321\",
        \"passportExpiry\": \"2029-06-15\",
        \"useProfile\": false
      }
    ]
  }" | jq .
```
**Expected outcome**:
- Status 201 with `intentId`, `status: "PENDING"`, confirmed pricing, and 2 passenger records
- Database: 1 `BookingIntent` row + 2 `BookingIntentPassenger` rows
- Passport fields encrypted in database (not plaintext)
- Audit log entry for `booking_intent_created`
---
### Scenario 2: Retrieve Booking Intent
**Purpose**: Verify intent retrieval with decrypted passenger data.
```bash
INTENT_ID="<from scenario 1 response>"
curl -s -X GET http://localhost:3001/bookings/intent/$INTENT_ID \
  -H "Authorization: Bearer $TOKEN" | jq .
```
**Expected outcome**:
- Status 200 with full passenger details including decrypted passport data
- Flight reference data (origin, destination, dates, cabin class)
- Pricing snapshot (original, confirmed, priceChanged, pricedAt)
---
### Scenario 3: Ownership Enforcement
**Purpose**: Verify users cannot access other users' intents.
```bash
# Login as a different user
TOKEN2=$(curl -s -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"other@example.com","password":"TestPassword123!"}' | jq -r '.accessToken')
# Try to access the first user's intent
curl -s -X GET http://localhost:3001/bookings/intent/$INTENT_ID \
  -H "Authorization: Bearer $TOKEN2" | jq .
```
**Expected outcome**: Status 403 Forbidden
---
### Scenario 4: Validation Errors
**Purpose**: Verify application-layer validation rules.
```bash
# Infants > adults
curl -s -X POST http://localhost:3001/bookings/intent \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"flightOfferId\": \"$OFFER_ID\",
    \"duffelOfferId\": \"$DUFFEL_OFFER_ID\",
    \"passengers\": [
      {\"type\":\"ADULT\",\"givenName\":\"John\",\"familyName\":\"Doe\",\"dateOfBirth\":\"1990-05-15\",\"gender\":\"male\"},
      {\"type\":\"INFANT\",\"givenName\":\"Baby\",\"familyName\":\"Doe\",\"dateOfBirth\":\"2025-01-01\",\"gender\":\"female\"},
      {\"type\":\"INFANT\",\"givenName\":\"Baby2\",\"familyName\":\"Doe\",\"dateOfBirth\":\"2025-06-01\",\"gender\":\"male\"}
    ]
  }" | jq .
```
**Expected outcome**: Status 400 with message about infants exceeding adults
---
### Scenario 5: Pre-Fill from Profile
**Purpose**: Verify TravelerProfile data is returned for form pre-filling.
```bash
curl -s -X GET http://localhost:3001/bookings/intent/prefill \
  -H "Authorization: Bearer $TOKEN" | jq .
```
**Expected outcome**:
- If profile exists: `hasProfile: true` with passenger data and `missingFields` array
- If no profile: `hasProfile: false`
---
### Scenario 6: Cron Cleanup (E2E Test Only)
**Purpose**: Verify two-phase cleanup lifecycle. This is validated via E2E tests, not manual commands.
**Expected behavior**:
1. Create a booking intent
2. Artificially set `createdAt` to 31 minutes ago
3. Trigger Phase 1 cleanup → status changes to `EXPIRED`
4. Artificially set `updatedAt` to 25 hours ago
5. Trigger Phase 2 cleanup → row is deleted
6. Verify cascade: `BookingIntentPassenger` rows also deleted
---
## Automated Test Commands
```bash
# Backend E2E — booking intent tests
npm run test:e2e --workspace=apps/api -- --testPathPattern=booking-intent
# Full backend E2E suite (regression)
npm run test:e2e --workspace=apps/api
```