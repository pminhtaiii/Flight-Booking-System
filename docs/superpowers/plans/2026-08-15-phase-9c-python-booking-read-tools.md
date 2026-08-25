# Feature 017 Phase 9C: Python Read Tools & Privacy-Minimized Formatting Plan

## Goal
Implement Phase 9C of Feature 017: Python agent read tools (`list_user_booking_summaries` and `get_booking_detail`), `NestJSClient` typed gateway methods, strict two-tier information disclosure, removal of legacy booking tools, prompt guidance in `TravelAssistant`, and comprehensive unit/integration test suites.

## Architecture & Data Flow
1. **NestJS Gateway Endpoints**:
   - `GET /api/agent-gateway/users/bookings/summaries`: returns `{ bookings: BookingSummaryDto[] }`.
   - `GET /api/agent-gateway/users/bookings/:bookingReference`: returns `BookingDetailDto` (or 404 `BOOKING_REFERENCE_NOT_FOUND`).
2. **NestJSClient**:
   - `get_gateway_user_booking_summaries()`: calls `/agent-gateway/users/bookings/summaries` with service API key and claim token headers.
   - `get_gateway_booking_detail(booking_reference: str)`: calls `/agent-gateway/users/bookings/{booking_reference}`.
3. **Python Agent Tools**:
   - `list_user_booking_summaries`: outputs tier-1 summary logistics (`bookingReference` with `bkref_...`, `airline`, `origin`, `destination`, `departureTime`, `arrivalTime`, `status`, `durationMinutes`, `stops`).
   - `get_booking_detail`: validates `booking_reference` and outputs tier-2 details (tier-1 fields plus `flightNumber`, `baggageAllowance`, `changeable`, `refundable`).
4. **Negative Privacy Contract**:
   - Absolutely NO database IDs, PNRs, payment details, amounts, currencies, passenger names/emails/phones, passport numbers, or raw provider orders in tool serialization.
5. **Registry & Prompt**:
   - Registry maintains exact 5 travel tools. Legacy `list_user_bookings` removed.
   - `TRAVEL_PROMPT` directs general booking queries to summaries and explicit single-booking queries to detail by reference.

## Implementation Steps (TDD)
1. **RED**: Write failing tests in `apps/agent/tests/test_booking_tools.py`, `apps/agent/tests/test_tools.py`, `apps/agent/tests/test_nestjs_client.py`.
2. **GREEN**:
   - Update `NestJSClient` in `apps/agent/src/agent/tools/nestjs_client.py`.
   - Implement `list_user_booking_summaries` in `apps/agent/src/agent/tools/booking_summaries.py`.
   - Implement `get_booking_detail` in `apps/agent/src/agent/tools/booking_detail.py`.
   - Update `apps/agent/src/agent/tools/registry.py` and remove `list_bookings.py`.
   - Update `apps/agent/src/agent/agents/travel_assistant.py`.
3. **REFACTOR / VERIFY**:
   - Run unit and integration tests with pytest.
   - Verify code reviews with standards and spec compliance subagents.
   - Update context files (`context/progress-checker.md`, `context/architecture.md`).
