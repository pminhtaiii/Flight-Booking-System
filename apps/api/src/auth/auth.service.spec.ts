import { envSchema } from '../app.module';

describe('Auth Service Config / App Config', () => {
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
