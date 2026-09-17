process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Type, ForwardReference } from '@nestjs/common';
import { AppModule, envSchema } from '@/app.module';
import { ConfigModule } from '@nestjs/config';
import { PaymentModule } from '@/payment/payment.module';
import { PaymentFulfillmentModule } from '@/payment-fulfillment/payment-fulfillment.module';
import { PaymentMethodsModule } from '@/payment/payment-methods.module';
import { PaymentMethodService } from '@/payment/payment-method.service';
import {
  PAYMENT_GATEWAY_PORT,
  PaymentGatewayPort,
} from '@/payment-fulfillment/ports/payment-gateway.port';
import {
  FULFILLMENT_GATEWAY_PORT,
  FulfillmentGatewayPort,
} from '@/payment-fulfillment/ports/fulfillment-gateway.port';
import { StripePaymentAdapter } from '@/common/stripe-payment.adapter';
import { DuffelFulfillmentAdapter } from '@/duffel/duffel-fulfillment.adapter';
import { PaymentFulfillmentSaga } from '@/payment-fulfillment/payment-fulfillment.saga';
import { BookingRecoveryService } from '@/booking-lifecycle/booking-recovery.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';

import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';

function assertDisposableDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    (!/(test|e2e|flight_booking)/i.test(databaseUrl) && process.env.NODE_ENV !== 'test')
  ) {
    throw new Error(
      'Refusing to run E2E composition gate against non-test database. Ensure DATABASE_URL targets a test/e2e database or NODE_ENV is set to "test".',
    );
  }
}

/**
 * Unwrap module references that might be wrapped in ForwardReference or DynamicModule
 */
function unwrapModuleToken(target: unknown): Type<unknown> | null {
  if (!target) return null;
  if (typeof target === 'function') return target as Type<unknown>;
  if (typeof target === 'object' && target !== null) {
    if ('forwardRef' in target && typeof (target as ForwardReference).forwardRef === 'function') {
      return (target as ForwardReference).forwardRef();
    }
    if ('module' in target && typeof (target as { module: unknown }).module === 'function') {
      return (target as { module: Type<unknown> }).module;
    }
  }
  return null;
}

/**
 * Recursively collect all imported module types via static metadata
 */
function collectTransitiveStaticImports(
  rootModule: Type<unknown>,
  visited = new Set<Type<unknown>>(),
): Set<Type<unknown>> {
  if (visited.has(rootModule)) return visited;
  visited.add(rootModule);

  const rawImports: unknown[] = Reflect.getMetadata('imports', rootModule) || [];
  for (const rawImport of rawImports) {
    const unwrapped = unwrapModuleToken(rawImport);
    if (unwrapped && !visited.has(unwrapped)) {
      collectTransitiveStaticImports(unwrapped, visited);
    }
  }

  return visited;
}

describe('Nest Composition Architecture Gate (US1 - T014)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    assertDisposableDatabase();

    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    const prisma = moduleFixture?.get(PrismaService, { strict: false });
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  describe('1. Gateway Port Resolution to Concrete Adapters', () => {
    it('resolves PAYMENT_GATEWAY_PORT to StripePaymentAdapter in AppModule', () => {
      const paymentGateway = moduleFixture.get<PaymentGatewayPort>(PAYMENT_GATEWAY_PORT);
      expect(paymentGateway).toBeDefined();
      expect(paymentGateway).toBeInstanceOf(StripePaymentAdapter);
    });

    it('resolves FULFILLMENT_GATEWAY_PORT to DuffelFulfillmentAdapter in AppModule', () => {
      const fulfillmentGateway = moduleFixture.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);
      expect(fulfillmentGateway).toBeDefined();
      expect(fulfillmentGateway).toBeInstanceOf(DuffelFulfillmentAdapter);
    });

    it('resolves both ports within PaymentFulfillmentModule scope', () => {
      const scopedPaymentGateway = moduleFixture
        .select(PaymentFulfillmentModule)
        .get<PaymentGatewayPort>(PAYMENT_GATEWAY_PORT);
      const scopedFulfillmentGateway = moduleFixture
        .select(PaymentFulfillmentModule)
        .get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);

      expect(scopedPaymentGateway).toBeInstanceOf(StripePaymentAdapter);
      expect(scopedFulfillmentGateway).toBeInstanceOf(DuffelFulfillmentAdapter);
    });

    it('injects concrete adapters into PaymentFulfillmentSaga', () => {
      const saga = moduleFixture.get<PaymentFulfillmentSaga>(PaymentFulfillmentSaga);
      expect(saga).toBeDefined();
      expect((saga as unknown as { paymentGateway: unknown }).paymentGateway).toBeInstanceOf(
        StripePaymentAdapter,
      );
      expect((saga as unknown as { fulfillmentGateway: unknown }).fulfillmentGateway).toBeInstanceOf(
        DuffelFulfillmentAdapter,
      );
    });

    it('compiles standalone PaymentFulfillmentModule with ConfigModule and resolves ports', async () => {
      const standaloneFixture = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            validate: (config) => envSchema.parse(config),
          }),
          ScheduleModule.forRoot(),
          PaymentFulfillmentModule,
        ],
      }).compile();

      const standalonePaymentGateway =
        standaloneFixture.get<PaymentGatewayPort>(PAYMENT_GATEWAY_PORT);
      const standaloneFulfillmentGateway =
        standaloneFixture.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);

      expect(standalonePaymentGateway).toBeInstanceOf(StripePaymentAdapter);
      expect(standaloneFulfillmentGateway).toBeInstanceOf(DuffelFulfillmentAdapter);

      const standalonePrisma = standaloneFixture.get(PrismaService, { strict: false });
      if (standalonePrisma) {
        await standalonePrisma.$disconnect();
      }
      await standaloneFixture.close();
    });
  });

  describe('2. Single Registration of PaymentMethodService', () => {
    it('registers PaymentMethodService in exactly one module across all active modules in AppModule', () => {
      const container = (moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } })
        .container;
      expect(container).toBeDefined();

      const modulesMap = container.getModules();
      expect(modulesMap.size).toBeGreaterThan(0);

      const modulesRegisteringService: string[] = [];

      for (const [, nestModule] of modulesMap) {
        const typedModule = nestModule as {
          metatype: Type<unknown>;
          providers: Map<unknown, unknown>;
        };

        if (typedModule.providers && typedModule.providers.has(PaymentMethodService)) {
          const moduleName = typedModule.metatype ? typedModule.metatype.name : 'UnknownModule';
          modulesRegisteringService.push(moduleName);
        }
      }

      expect(modulesRegisteringService).toHaveLength(1);
      expect(modulesRegisteringService[0]).toBe('PaymentMethodsModule');
    });

    it('declares PaymentMethodService in PaymentMethodsModule metadata, and NOT in PaymentModule or PaymentFulfillmentModule', () => {
      const methodsProviders: unknown[] =
        Reflect.getMetadata('providers', PaymentMethodsModule) || [];
      const paymentProviders: unknown[] = Reflect.getMetadata('providers', PaymentModule) || [];
      const fulfillmentProviders: unknown[] =
        Reflect.getMetadata('providers', PaymentFulfillmentModule) || [];

      expect(methodsProviders).toContain(PaymentMethodService);
      expect(paymentProviders).not.toContain(PaymentMethodService);
      expect(fulfillmentProviders).not.toContain(PaymentMethodService);
    });

    it('resolves the identical singleton instance of PaymentMethodService across all consuming modules', () => {
      const rootInstance = moduleFixture.get(PaymentMethodService);
      const paymentInstance = moduleFixture.select(PaymentModule).get(PaymentMethodService);
      const fulfillmentInstance = moduleFixture
        .select(PaymentFulfillmentModule)
        .get(PaymentMethodService);
      const methodsInstance = moduleFixture.select(PaymentMethodsModule).get(PaymentMethodService);

      expect(rootInstance).toBeDefined();
      expect(rootInstance).toBe(paymentInstance);
      expect(paymentInstance).toBe(fulfillmentInstance);
      expect(fulfillmentInstance).toBe(methodsInstance);
    });
  });

  describe('3. Zero Circular Dependencies Between PaymentModule and PaymentFulfillmentModule', () => {
    it('verifies static module metadata: PaymentModule imports PaymentFulfillmentModule, PaymentFulfillmentModule does NOT import PaymentModule', () => {
      const paymentImports: unknown[] = Reflect.getMetadata('imports', PaymentModule) || [];
      const fulfillmentImports: unknown[] =
        Reflect.getMetadata('imports', PaymentFulfillmentModule) || [];

      const unwrappedPaymentImports = paymentImports.map(unwrapModuleToken);
      const unwrappedFulfillmentImports = fulfillmentImports.map(unwrapModuleToken);

      expect(unwrappedPaymentImports).toContain(PaymentFulfillmentModule);
      expect(unwrappedFulfillmentImports).not.toContain(PaymentModule);
    });

    it('verifies zero direct or transitive import of PaymentModule from PaymentFulfillmentModule', () => {
      const transitiveImportsFromFulfillment =
        collectTransitiveStaticImports(PaymentFulfillmentModule);

      // Root PaymentFulfillmentModule is in the set
      expect(transitiveImportsFromFulfillment.has(PaymentFulfillmentModule)).toBe(true);

      // Crucial assertion: PaymentModule must NEVER be in the dependency closure of PaymentFulfillmentModule
      expect(transitiveImportsFromFulfillment.has(PaymentModule)).toBe(false);
    });

    it('verifies runtime NestContainer dependency graph has no reverse link or cycle', () => {
      const container = (moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } })
        .container;
      const modulesMap = container.getModules();

      let paymentNestModule: { imports?: Set<unknown>; relatedModules?: Set<unknown>; metatype: Type<unknown> } | null = null;
      let fulfillmentNestModule: { imports?: Set<unknown>; relatedModules?: Set<unknown>; metatype: Type<unknown> } | null = null;

      for (const [, mod] of modulesMap) {
        const typed = mod as { imports?: Set<unknown>; relatedModules?: Set<unknown>; metatype: Type<unknown> };
        if (typed.metatype === PaymentModule) paymentNestModule = typed;
        if (typed.metatype === PaymentFulfillmentModule) fulfillmentNestModule = typed;
      }

      expect(paymentNestModule).toBeDefined();
      expect(fulfillmentNestModule).toBeDefined();

      const getRelated = (m: { imports?: Set<unknown>; relatedModules?: Set<unknown> }): Set<unknown> =>
        m.relatedModules ?? m.imports ?? new Set();

      // BFS to find reachable modules from fulfillmentNestModule
      const reachableFromFulfillment = new Set<unknown>();
      const queue: unknown[] = [fulfillmentNestModule];

      while (queue.length > 0) {
        const curr = queue.shift() as { imports?: Set<unknown>; relatedModules?: Set<unknown>; metatype: Type<unknown> };
        if (!curr || reachableFromFulfillment.has(curr)) continue;
        reachableFromFulfillment.add(curr);

        const related = getRelated(curr);
        for (const rel of related) {
          if (!reachableFromFulfillment.has(rel)) {
            queue.push(rel);
          }
        }
      }

      // Assert runtime container reachability: PaymentModule is NOT reachable from PaymentFulfillmentModule
      expect(reachableFromFulfillment.has(paymentNestModule)).toBe(false);
    });
  });

  describe('4. BookingRecoveryService Retains Direct SDK Wrappers', () => {
    it('injects direct StripeService and DuffelService into BookingRecoveryService constructor metadata', () => {
      const paramTypes: unknown[] =
        Reflect.getMetadata('design:paramtypes', BookingRecoveryService) || [];

      expect(paramTypes).toContain(StripeService);
      expect(paramTypes).toContain(DuffelService);

      // Must NOT inject saga port tokens or adapter classes
      expect(paramTypes).not.toContain(StripePaymentAdapter);
      expect(paramTypes).not.toContain(DuffelFulfillmentAdapter);
    });

    it('holds direct SDK instances at runtime and does NOT expose saga ports or adapter instances', () => {
      const recoveryService = moduleFixture.get<BookingRecoveryService>(BookingRecoveryService);
      expect(recoveryService).toBeDefined();

      const typedService = recoveryService as unknown as {
        stripeService: unknown;
        duffelService: unknown;
        paymentGateway?: unknown;
        fulfillmentGateway?: unknown;
        saga?: unknown;
      };

      // Assert direct SDK wrapper instances
      expect(typedService.stripeService).toBeDefined();
      expect(typedService.stripeService).toBeInstanceOf(StripeService);
      expect(typedService.stripeService).not.toBeInstanceOf(StripePaymentAdapter);

      expect(typedService.duffelService).toBeDefined();
      expect(typedService.duffelService).toBeInstanceOf(DuffelService);
      expect(typedService.duffelService).not.toBeInstanceOf(DuffelFulfillmentAdapter);

      // Assert absence of saga ports or saga routing
      expect(typedService.paymentGateway).toBeUndefined();
      expect(typedService.fulfillmentGateway).toBeUndefined();
      expect(typedService.saga).toBeUndefined();
    });
  });

  describe('5. Strict Phase Invariants (No Premature Phase 4 / US2 Leaks)', () => {
    it('does not register EventEmitterModule or EventEmitter2 in AppModule for US1', () => {
      let resolvedEventEmitter: unknown = null;
      try {
        resolvedEventEmitter = moduleFixture.get('EventEmitter2', { strict: false });
      } catch {
        resolvedEventEmitter = null;
      }

      expect(resolvedEventEmitter).toBeNull();
    });

    it('does not register BookingProjectionModule or BookingEventPublisherService in AppModule for US1', () => {
      const container = (moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } })
        .container;
      const modulesMap = container.getModules();

      const registeredModuleNames: string[] = [];
      for (const [, nestModule] of modulesMap) {
        const typedModule = nestModule as { metatype?: Type<unknown> };
        if (typedModule.metatype?.name) {
          registeredModuleNames.push(typedModule.metatype.name);
        }
      }

      expect(registeredModuleNames).not.toContain('BookingProjectionModule');
      expect(registeredModuleNames).not.toContain('DomainEventsModule');
      expect(registeredModuleNames).not.toContain('BookingStateModule');
    });
  });
});
