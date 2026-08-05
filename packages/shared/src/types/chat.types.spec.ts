// @ts-nocheck
import { actionHandoffSchema } from './chat.types';

describe('Chat Events Contract', () => {
  const fixtures = {
    valid_handoff_event: {
      version: 1,
      action: "begin_checkout",
      handoffToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      expiresAt: "2026-08-05T10:00:00Z",
      display: {
        airline: "Delta Air Lines",
        origin: "JFK",
        destination: "LAX",
        departureAt: "2026-09-01T08:00:00Z",
        arrivalAt: "2026-09-01T11:00:00Z",
        price: "450.00",
        currency: "USD"
      }
    },
    invalid_handoff_event_missing_token: {
      version: 1,
      action: "begin_checkout",
      expiresAt: "2026-08-05T10:00:00Z",
      display: {
        airline: "Delta",
        origin: "JFK",
        destination: "LAX",
        departureAt: "2026-09-01T08:00:00Z",
        arrivalAt: "2026-09-01T11:00:00Z",
        price: "450.00",
        currency: "USD"
      }
    },
    invalid_handoff_event_extra_fields: {
      version: 1,
      action: "begin_checkout",
      handoffToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      expiresAt: "2026-08-05T10:00:00Z",
      display: {
        airline: "Delta Air Lines",
        origin: "JFK",
        destination: "LAX",
        departureAt: "2026-09-01T08:00:00Z",
        arrivalAt: "2026-09-01T11:00:00Z",
        price: "450.00",
        currency: "USD"
      },
      offerId: "offer_12345",
      sessionId: "session_67890"
    }
  };

  it('accepts valid handoff event', () => {
    const result = actionHandoffSchema.safeParse(fixtures.valid_handoff_event);
    expect(result.success).toBe(true);
  });

  it('rejects handoff event with missing token', () => {
    const result = actionHandoffSchema.safeParse(fixtures.invalid_handoff_event_missing_token);
    expect(result.success).toBe(false);
  });

  it('rejects handoff event with extra identifier fields', () => {
    const StrictHandoffSchema = actionHandoffSchema.strict();
    const result = StrictHandoffSchema.safeParse(fixtures.invalid_handoff_event_extra_fields);
    expect(result.success).toBe(false);
  });
});
