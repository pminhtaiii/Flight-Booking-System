# Feature Specification: Booking Intent Foundation
**Feature Branch**: `009-booking-intent-foundation`
**Created**: 2026-07-10
**Status**: Draft
**Input**: Grilling session decisions from `research/booking-workflow-decisions.md`
## User Scenarios & Testing *(mandatory)*
### User Story 1 - Create Booking Intent from Flight Offer (Priority: P1)
A logged-in user viewing a flight offer clicks "Book this Flight." The system validates the passenger details, calls Duffel to re-confirm pricing, and creates a `BookingIntent` record with a pricing snapshot and all passenger data. The user sees a review/confirmation screen with the confirmed price. If the price changed from the original search, the user is informed before proceeding.
**Why this priority**: Without a booking intent, there is no bridge between "I found a flight" and "I want to pay for it." This is the transactional foundation for the entire booking workflow.
**Independent Test**: Select a flight offer from search results, submit passenger details for 2 adults, verify the system creates a `BookingIntent` with `PENDING` status and a `BookingIntentPassenger` row per passenger with a confirmed pricing snapshot.
**Acceptance Scenarios**:
1. **Given** a logged-in user on the flight detail page, **When** they submit valid passenger details (name, DOB, passport, nationality) for all passengers, **Then** the system calls Duffel to re-price the offer, creates a `BookingIntent` with status `PENDING`, and returns the confirmed price + intent ID.
2. **Given** a booking intent is being created, **When** the Duffel re-pricing returns a different price than the original search, **Then** the response includes `priceChanged: true` with both the original and confirmed prices so the user can decide whether to proceed.
3. **Given** a logged-in user with a `TravelerProfile`, **When** they initiate a booking, **Then** the primary passenger's form is pre-filled with data from their profile (name, DOB, passport, nationality) and they only need to enter missing fields.
4. **Given** a booking intent for 2 adults + 1 child, **When** the passenger form is submitted, **Then** the system creates 3 `BookingIntentPassenger` rows — one per passenger — with encrypted passport data (AES-256-GCM).
5. **Given** a user submits passenger details where infants > adults, **When** the validation runs, **Then** the system returns a 400 error with a clear message: "Number of infants cannot exceed number of adults."
---
### User Story 2 - Abandoned Intent Cleanup (Priority: P1)
The system automatically manages stale booking intents using a two-phase cleanup: first marking old `PENDING` intents as `EXPIRED`, then hard-deleting `EXPIRED` intents after a grace period. This prevents database pollution while eliminating race conditions with in-flight payments.
**Why this priority**: Without cleanup, every abandoned booking attempt permanently pollutes the database. Without two-phase cleanup, a race condition between the cron and an in-flight payment can cause money loss.
**Independent Test**: Create a `BookingIntent` with `PENDING` status and a `createdAt` timestamp older than the TTL. Run the cleanup cron. Verify the intent is marked `EXPIRED` (not deleted). Wait for the grace period. Run cleanup again. Verify the intent is hard-deleted.
**Acceptance Scenarios**:
1. **Given** a `BookingIntent` with status `PENDING` created more than 30 minutes ago, **When** the Phase 1 cron runs, **Then** the intent's status is updated to `EXPIRED` and a structured log is emitted.
2. **Given** a `BookingIntent` with status `EXPIRED` last updated more than 24 hours ago, **When** the Phase 2 cron runs, **Then** the intent and its associated `BookingIntentPassenger` rows are hard-deleted via cascading delete.
3. **Given** a `BookingIntent` with status `PENDING` created less than 30 minutes ago, **When** the Phase 1 cron runs, **Then** the intent is untouched.
4. **Given** a `BookingIntent` with status `EXPIRED` last updated less than 24 hours ago, **When** the Phase 2 cron runs, **Then** the intent is untouched (grace period not yet elapsed).
---
### User Story 3 - Retrieve Booking Intent for Review (Priority: P1)
A user who has created a booking intent can retrieve it to review passenger details and confirmed pricing before proceeding to payment (Feature B). The system returns the intent with all passenger data and pricing snapshot.
**Why this priority**: The review step is the bridge between intent creation (Feature A) and payment (Feature B). Without it, the user cannot confirm their booking before paying.
**Independent Test**: Create a booking intent, then fetch it by ID. Verify all passenger details, pricing snapshot, and flight reference data are returned correctly.
**Acceptance Scenarios**:
1. **Given** a logged-in user with an existing `BookingIntent` in `PENDING` status, **When** they request the intent by ID, **Then** the system returns all passenger details (with passport data decrypted for the owning user), pricing snapshot, and flight reference.
2. **Given** a logged-in user requesting a booking intent belonging to a different user, **When** the request is processed, **Then** the system returns 403 Forbidden.
3. **Given** a booking intent with status `EXPIRED`, **When** the user requests it, **Then** the system returns 410 Gone with a message indicating the intent has expired and they should search again.
---
## Scope & Boundaries
### In Scope
- `BookingIntent` and `BookingIntentPassenger` Prisma models + migration
- `BookingIntentModule` NestJS module (controller, service, DTOs)
- Duffel offer re-pricing at intent creation (reuse existing `offers.get()`)
- Passenger validation (application-layer business rules)
- Pre-fill from `TravelerProfile` (primary passenger only, snapshot copy)
- PII encryption for passport fields (AES-256-GCM, same pattern as `TravelerProfile`)
- Two-phase cron cleanup (PENDING → EXPIRED → hard delete)
- Audit logging for intent creation, expiration, and deletion
- API endpoints: `POST /bookings/intent`, `GET /bookings/intent/:id`
### Out of Scope
- Payment processing (Feature B)
- PNR creation / Duffel order creation (Feature B)
- Frontend booking form UI (Feature B)
- Bookings management pages (Feature C)
- `SavedTraveler` / companion profiles refactor (separate feature)
- Cancellation and refund flows (Feature C)
- Email/SMS notifications (Feature B)
### Deferred Decisions (Documented)
- **GDPR erasure cascade**: Whether PII deletion must cascade into intent/booking rows is a legal/compliance decision. The system design supports it (cascade delete), but the policy decision is deferred.
- **Companion profiles**: Extending `TravelerProfile` to 1:many (`SavedTraveler`) for pre-filling non-primary passengers. Important UX improvement, deferred to a separate feature.
- **Frontend UX structure**: Multi-step wizard vs. single page for the booking form. Deferred to Feature B.
- **Staleness re-check at payment time**: Feature B must re-validate pricing before charging. The `pricedAt` timestamp in `BookingIntent` enables this.
---
## Non-Functional Requirements
- **Encryption**: Passport numbers and expiry dates encrypted with AES-256-GCM at application layer before storage, matching the `TravelerProfile` pattern.
- **Performance**: Intent creation (including Duffel re-pricing) should complete within 5 seconds.
- **Cleanup reliability**: Cron jobs must be idempotent — running them multiple times produces the same result.
- **Audit trail**: Every intent lifecycle event (created, expired, deleted) must produce a structured audit log entry.
- **Authorization**: Users can only access their own booking intents.
