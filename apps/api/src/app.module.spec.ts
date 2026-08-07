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

  it('should validate JWT_SECRET and keys', () => {
    const validConfig = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      JWT_SECRET: 'mysecret',
      CHAT_ENCRYPTION_KEY: 'enc_key',
      CHAT_ATTESTATION_KEY: 'att_key',
    };
    const parsed = envSchema.parse(validConfig);
    expect(parsed.JWT_SECRET).toBe('mysecret');
    expect(parsed.CHAT_ENCRYPTION_KEY).toBe('enc_key');
    expect(parsed.CHAT_ATTESTATION_KEY).toBe('att_key');
  });

  it('should apply defaults for chat handoff config', () => {
    const validConfig = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
    };
    const parsed = envSchema.parse(validConfig);
    expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT).toBe('false');
    expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ISSUE).toBe('false');
    expect(parsed.CHAT_HANDOFF_CLAIM_TTL).toBe(600);
  });
});
