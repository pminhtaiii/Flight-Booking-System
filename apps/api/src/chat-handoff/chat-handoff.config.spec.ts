import { envSchema } from '../app.module';

describe('Chat Handoff Config Validation', () => {
  it('should reject ISSUE=true when ACCEPT=false', () => {
    const invalidConfig = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
      FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'false',
    };
    
    const result = envSchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].message).toBe('Invalid config: ISSUE=true but ACCEPT=false');
    }
  });

  it('should accept ISSUE=true when ACCEPT=true', () => {
    const validConfig = {
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
      FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
      FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
    };
    
    const result = envSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });
});
