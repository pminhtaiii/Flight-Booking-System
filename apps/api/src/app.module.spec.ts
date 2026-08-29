import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { AppModule, envSchema } from './app.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { BookingManagementModule } from './booking-management/booking-management.module';
import { ProfileModule } from './profile/profile.module';
import { PaymentModule } from './payment/payment.module';
import { CacheModule } from './cache/cache.module';

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

  describe('Feature Flag Governance & Rollout Matrix', () => {
    it('Combination 1: accepts ISSUE=false and ACCEPT=false', () => {
      const parsed = envSchema.parse({
        ...baseConfig,
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'false',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'false',
      });
      expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ISSUE).toBe('false');
      expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT).toBe('false');
    });

    it('Combination 2: accepts ISSUE=false and ACCEPT=true', () => {
      const parsed = envSchema.parse({
        ...baseConfig,
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'false',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
      });
      expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ISSUE).toBe('false');
      expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT).toBe('true');
    });

    it('Combination 3: rejects ISSUE=true and ACCEPT=false at startup with clear error', () => {
      expect(() =>
        envSchema.parse({
          ...baseConfig,
          FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
          FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'false',
        }),
      ).toThrow('Invalid config: ISSUE=true but ACCEPT=false');
    });

    it('Combination 4: accepts ISSUE=true and ACCEPT=true', () => {
      const parsed = envSchema.parse({
        ...baseConfig,
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
      });
      expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ISSUE).toBe('true');
      expect(parsed.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT).toBe('true');
    });

    it('permits configured secret rotation keys (CHAT_HANDOFF_SECRET, V1, V2, V3)', () => {
      const parsed = envSchema.parse({
        ...baseConfig,
        CHAT_HANDOFF_SECRET: 'legacy-secret',
        CHAT_HANDOFF_SECRET_V1: 'secret-v1',
        CHAT_HANDOFF_SECRET_V2: 'secret-v2',
        CHAT_HANDOFF_SECRET_V3: 'secret-v3',
      });
      expect(parsed.CHAT_HANDOFF_SECRET).toBe('legacy-secret');
      expect(parsed.CHAT_HANDOFF_SECRET_V1).toBe('secret-v1');
      expect(parsed.CHAT_HANDOFF_SECRET_V2).toBe('secret-v2');
      expect(parsed.CHAT_HANDOFF_SECRET_V3).toBe('secret-v3');
    });
  });
});

describe('AppModule Dependency Graph & DashboardModule Registration (T017 / T018)', () => {
  it('registers DashboardModule in AppModule imports array', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
    expect(imports).toBeDefined();
    expect(imports).toContain(DashboardModule);
  });

  it('verifies DashboardModule imports only PrismaModule and strictly excludes heavy dependencies', () => {
    const dashboardImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, DashboardModule) ?? []) as unknown[];
    expect(dashboardImports).toContain(PrismaModule);
    expect(dashboardImports).not.toContain(BookingManagementModule);
    expect(dashboardImports).not.toContain(ProfileModule);
    expect(dashboardImports).not.toContain(PaymentModule);
    expect(dashboardImports).not.toContain(CacheModule);
  });

  it('verifies DashboardModule registers DashboardController and provides/exports DashboardService', () => {
    const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, DashboardModule) ?? []) as unknown[];
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, DashboardModule) ?? []) as unknown[];
    const exports = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, DashboardModule) ?? []) as unknown[];

    expect(controllers).toContain(DashboardController);
    expect(providers).toContain(DashboardService);
    expect(exports).toContain(DashboardService);
  });

  it('compiles DashboardModule cleanly with NestJS Test.createTestingModule without errors', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DashboardModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
    const controller = moduleRef.get<DashboardController>(DashboardController);
    const service = moduleRef.get<DashboardService>(DashboardService);
    expect(controller).toBeDefined();
    expect(controller).toBeInstanceOf(DashboardController);
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(DashboardService);
  });
});


