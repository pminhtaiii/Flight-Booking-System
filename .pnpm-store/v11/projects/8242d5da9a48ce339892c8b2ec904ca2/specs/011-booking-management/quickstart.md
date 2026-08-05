# Quickstart: Bookings Management & Confirmation

**Feature**: 011-booking-management | **Date**: 2026-07-19

## Prerequisites

- Docker Desktop running (PostgreSQL + Redis via `docker compose up -d`)
- Database migrated: `npx prisma migrate dev --schema=apps/api/prisma/schema.prisma`
- Database seeded: `npx prisma db seed --schema=apps/api/prisma/schema.prisma`
- Environment variables configured in `apps/api/.env` and `apps/web/.env`
- Feature 10 (Stripe Payment System) Phase 7+ completed

## Setup

```bash
# Start services
docker compose up -d

# Run migrations (will include new Booking model)
npx prisma migrate dev --schema=apps/api/prisma/schema.prisma

# Start full stack
pnpm dev
```

## Validation Scenarios

### Scenario 1: Successful Booking Confirmation Flow

**Goal**: Verify the complete post-payment experience from checkout to confirmation.

1. Login to the application at `http://localhost:3000/login`
2. Search for a flight and proceed to checkout
3. Enter payment details via Stripe Elements
4. Click "Confirm Payment"
5. **Verify**: Loading escalation appears with animated stepper
6. **Verify**: Upon success, redirect to `/bookings/[bookingId]?confirmed=true`
7. **Verify**: Confirmation banner with PNR reference is displayed
8. **Verify**: Flight details (airline, times, airports) match the searched flight
9. **Verify**: Refreshing the page (without `?confirmed=true`) shows normal detail view

**Expected**: Booking status is `CONFIRMED`, flight snapshot is populated, PNR reference is visible.

### Scenario 2: Pipeline Failure — Booking Detail Shows Error State

**Goal**: Verify failure states render correctly with context-aware retry.

1. Trigger a pipeline failure (e.g., use an expired Duffel offer or simulate timeout)
2. **Verify**: Redirect to `/bookings/[bookingId]` without `?confirmed=true`
3. **Verify**: Failure state renders with:
   - Error explanation matching the `failureReason`
   - Charge status derived from `Payment.status` (not hardcoded)
   - Context-aware retry button (e.g., "Search Again" for OFFER_EXPIRED)
4. **Verify**: Clicking retry navigates to the correct destination

**Expected**: Booking status is `FAILED`, failureReason is set, retry button routes correctly.

### Scenario 3: My Bookings List — Tab Navigation

**Goal**: Verify the bookings list page with tab filtering.

1. Navigate to `/bookings`
2. **Verify**: Upcoming tab shows bookings with future departure dates + PROCESSING + FAILED
3. **Verify**: Past tab shows bookings with past departure dates
4. **Verify**: Each row shows destination, dates, airline, PNR, status badge
5. **Verify**: Failed bookings have a "Failed" badge with retry action
6. **Verify**: PROCESSING bookings have a "Processing" badge
7. **Verify**: Empty state shows "Search Flights" CTA when no bookings exist

### Scenario 4: Client-Generated UUID Security

**Goal**: Verify server-side UUID validation prevents cross-user ID injection.

1. Complete a booking as User A, note the `bookingId`
2. Login as User B
3. Attempt to send a confirm request with User A's `bookingId`
4. **Verify**: Server returns 403 Forbidden
5. Attempt to send a confirm request with an invalid UUID format
6. **Verify**: Server returns 400 Bad Request

### Scenario 5: Loading Escalation — Long Pipeline

**Goal**: Verify the 4-phase checkout loading escalation handles slow pipelines.

1. Simulate a slow Duffel response (>20 seconds)
2. Click "Confirm Payment"
3. **Verify Phase 1 (0-10s)**: Animated stepper transitions through steps
4. **Verify Phase 2 (10-20s)**: Reassurance message appears
5. **Verify Phase 3 (20s+)**: "Check My Bookings" escape hatch link appears
6. **Verify Phase 4 (45s+)**: Auto-redirect to `/bookings/[bookingId]`
7. After redirect, **Verify**: Booking detail page shows current state from DB

## Automated Test Commands

```bash
# Backend E2E tests
npm run test:e2e --workspace=apps/api

# Frontend Playwright tests
npx playwright test --config=apps/web/tests/playwright.config.ts
```
