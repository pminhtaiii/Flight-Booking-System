import { envSchema } from './app.module';

describe('AppModule Config Validation', () => {
  const baseConfig = {
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
  };

  it('defaults FEATURE_FLAG_BOOKING_READINESS to "false" when not provided', () => {
    const result = envSchema.parse({ ...baseConfig });
    expect(result.FEATURE_FLAG_BOOKING_READINESS).toBe('false');
  });

  it('accepts explicit "true" value for FEATURE_FLAG_BOOKING_READINESS', () => {
    const result = envSchema.parse({
      ...baseConfig,
      FEATURE_FLAG_BOOKING_READINESS: 'true',
    });
    expect(result.FEATURE_FLAG_BOOKING_READINESS).toBe('true');
  });

  it('accepts explicit "false" value for FEATURE_FLAG_BOOKING_READINESS', () => {
    const result = envSchema.parse({
      ...baseConfig,
      FEATURE_FLAG_BOOKING_READINESS: 'false',
    });
    expect(result.FEATURE_FLAG_BOOKING_READINESS).toBe('false');
  });

  it('does not change unrelated required environment validation', () => {
    expect(() => envSchema.parse({})).toThrow();
  });
});
