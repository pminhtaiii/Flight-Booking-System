import { envSchema } from '../app.module';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { ChatHandoffController } from './chat-handoff.controller';
import { ChatHandoffService } from './chat-handoff.service';

// User approved updating existing tests for Feature 017 T093 contract coverage on 2026-08-10.

describe('Chat Handoff Config Validation', () => {
  function configService(values: Record<string, string>): ConfigService {
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

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

  it('rejects create when ISSUE=false even while ACCEPT honors existing credentials', async () => {
    const handoffService = {
      create: jest.fn(),
      resolve: jest.fn(),
    };
    const controller = new ChatHandoffController(
      handoffService as unknown as ChatHandoffService,
      configService({
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'false',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
      }),
    );

    await expect(controller.create({} as never)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(handoffService.create).not.toHaveBeenCalled();
  });

  it('honors existing credentials when ACCEPT=true after ISSUE rollback', async () => {
    const handoffService = {
      create: jest.fn(),
      resolve: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
    };
    const controller = new ChatHandoffController(
      handoffService as unknown as ChatHandoffService,
      configService({
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'false',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
      }),
    );

    await expect(
      controller.resolve({ token: 'chk_handoff_v1_test' }, { user: { id: 'user-1' } }),
    ).resolves.toEqual({ status: 'ACTIVE' });
    expect(handoffService.resolve).toHaveBeenCalledWith(
      'chk_handoff_v1_test',
      'user-1',
      { traceId: undefined, correlationId: undefined },
    );
  });

  it('returns a stable disabled error when ACCEPT=false', async () => {
    const handoffService = {
      create: jest.fn(),
      resolve: jest.fn(),
    };
    const controller = new ChatHandoffController(
      handoffService as unknown as ChatHandoffService,
      configService({
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'false',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'false',
      }),
    );

    await expect(
      controller.resolve({ token: 'chk_handoff_v1_test' }, { user: { id: 'user-1' } }),
    ).rejects.toThrow('Chat handoff acceptance is disabled');
    expect(handoffService.resolve).not.toHaveBeenCalled();
  });
});
