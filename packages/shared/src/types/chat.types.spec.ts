// @ts-nocheck
import { z } from 'zod';

export const HandoffEventSchema = z.object({
  version: z.string(),
  action: z.literal('begin_checkout'),
  handoffToken: z.string(),
  expiresAt: z.string(),
  airline: z.string(),
  route: z.string(),
  departure: z.string(),
  price: z.number(),
  currency: z.string(),
});

describe('Chat Events Contract', () => {
  const fixtures = {
    valid_handoff_event: {
      version: "1.0",
      action: "begin_checkout",
      handoffToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      expiresAt: "2026-08-05T10:00:00Z",
      airline: "Delta Air Lines",
      route: "JFK - LAX",
      departure: "2026-09-01T08:00:00Z",
      price: 450.00,
      currency: "USD"
    },
    invalid_handoff_event_missing_token: {
      version: "1.0",
      action: "begin_checkout",
      expiresAt: "2026-08-05T10:00:00Z",
      airline: "Delta",
      route: "JFK - LAX",
      departure: "2026-09-01T08:00:00Z",
      price: 450.00,
      currency: "USD"
    },
    invalid_handoff_event_extra_fields: {
      version: "1.0",
      action: "begin_checkout",
      handoffToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      expiresAt: "2026-08-05T10:00:00Z",
      airline: "Delta Air Lines",
      route: "JFK - LAX",
      departure: "2026-09-01T08:00:00Z",
      price: 450.00,
      currency: "USD",
      offerId: "offer_12345",
      sessionId: "session_67890"
    }
  };

  it('accepts valid handoff event', () => {
    const result = HandoffEventSchema.safeParse(fixtures.valid_handoff_event);
    expect(result.success).toBe(true);
  });

  it('rejects handoff event with missing token', () => {
    const result = HandoffEventSchema.safeParse(fixtures.invalid_handoff_event_missing_token);
    expect(result.success).toBe(false);
  });

  it('rejects handoff event with extra identifier fields', () => {
    const StrictHandoffSchema = HandoffEventSchema.strict();
    const result = StrictHandoffSchema.safeParse(fixtures.invalid_handoff_event_extra_fields);
    expect(result.success).toBe(false);
  });
});
