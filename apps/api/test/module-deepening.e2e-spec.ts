process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Type, ForwardReference } from '@nestjs/common';
import { AppModule, envSchema } from '@/app.module';
import { ConfigModule } from '@nestjs/config';
import { IdempotencyModule } from '@/idempotency/idempotency.module';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { PaymentModule } from '@/payment/payment.module';
import { PaymentFulfillmentModule } from '@/payment-fulfillment/payment-fulfillment.module';
import { PaymentFulfillmentSaga } from '@/payment-fulfillment/payment-fulfillment.saga';
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
import { BookingRecoveryService } from '@/booking-lifecycle/booking-recovery.service';
import { BookingLifecycleModule } from '@/booking-lifecycle/booking-lifecycle.module';
import { BookingStateModule } from '@/booking-lifecycle/booking-state.module';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { CancellationModule } from '@/cancellation/cancellation.module';
import { DisruptionModule } from '@/disruption/disruption.module';
import { RefundSettlementModule } from '@/refund-settlement/refund-settlement.module';
import { StripeService } from '@/common/stripe.service';
import { DuffelService } from '@/duffel/duffel.service';

import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';
import { BookingProjectionModule } from '@/booking-projection/booking-projection.module';
import { BookingProjectionListener } from '@/booking-projection/booking-projection.listener';
import { BookingProjectionRepository } from '@/booking-projection/booking-projection.repository';
import { BookingProjectionService } from '@/booking-projection/booking-projection.service';
import { BookingProjectionMetrics } from '@/booking-projection/booking-projection.metrics';
import { BookingProjectionReconciliationService } from '@/booking-projection/booking-projection-reconciliation.service';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { BookingEventPublisherService } from '@/domain-events/booking-event-publisher.service';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { EventEmitter2 } from '@nestjs/event-emitter';

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

type MutationInventoryEntry = {
  id: string;
  source: string;
  method: string;
  requiredMarkers: readonly string[];
  countMarkers?: readonly { marker: string; count: number }[];
};

const MUTATION_INVENTORY: readonly MutationInventoryEntry[] = [
  {
    id: 'booking.created',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'createBooking',
    requiredMarkers: ['version: 1', 'BookingCreatedEvent', 'sourceVersion', 'publisher.publish'],
  },
  {
    id: 'booking.confirmed',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'updateToConfirmed',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingConfirmedEvent',
      'sourceVersion',
      'executeMutation',
    ],
  },
  {
    id: 'booking.failed',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'updateToFailed',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingFailedEvent',
      'sourceVersion',
      'executeMutation',
    ],
  },
  {
    id: 'booking.completed',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'checkAndCompleteBooking',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingCompletedEvent',
      'sourceVersion',
      'publisher.publish(localEvents)',
    ],
  },
  {
    id: 'booking.cancellation.pending',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'claimCancellation',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingCancellationPendingEvent',
      'sourceVersion',
      'executeMutation',
    ],
  },
  {
    id: 'booking.cancelled',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'cancelBooking',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingCancelledEvent',
      'sourceVersion',
      'executeMutation',
    ],
  },
  {
    id: 'booking.refund.updated',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'updateBookingRefundStatus',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingRefundUpdatedEvent',
      'sourceVersion',
      'executeMutation',
    ],
  },
  {
    id: 'booking.recovery.resolved',
    source: 'booking-lifecycle/booking-lifecycle.service.ts',
    method: 'recordRecoveryOutcome',
    requiredMarkers: [
      'version: { increment: 1 }',
      'BookingRecoveryResolvedEvent',
      'sourceVersion',
      'executeMutation',
    ],
  },
  {
    id: 'booking.recovery.branches',
    source: 'booking-lifecycle/booking-recovery.service.ts',
    method: 'reconcileBookingIfStale',
    requiredMarkers: [
      'createContext(tx)',
      'bookingLifecycleService.failBooking',
      'bookingLifecycleService.confirmBooking',
      'publisher.publish(eventContext.events)',
    ],
    countMarkers: [
      { marker: 'createContext(tx)', count: 4 },
      { marker: 'publisher.publish(eventContext.events)', count: 4 },
      { marker: 'bookingLifecycleService.failBooking', count: 3 },
      { marker: 'bookingLifecycleService.confirmBooking', count: 1 },
    ],
  },
  {
    id: 'booking.cancellation.service',
    source: 'cancellation/cancellation.service.ts',
    method: 'cancelBooking',
    requiredMarkers: [
      'bookingLifecycleService.claimCancellation',
      'bookingLifecycleService.cancelBooking',
      'claimContext.events',
      'cancelContext.events',
      'publisher.publish(claimEvents)',
      'publisher.publish(finalEvents)',
    ],
  },
  {
    id: 'booking.disruption.synced',
    source: 'disruption/sync/supplier-sync.service.ts',
    method: 'syncBooking',
    requiredMarkers: [
      'createContext(tx)',
      'version: { increment: 1 }',
      'BookingDisruptionSyncedEvent',
      'publisher.publish(eventsToPublish)',
    ],
  },
  {
    id: 'booking.disruption.acknowledged',
    source: 'disruption/api/disruption.service.ts',
    method: 'acknowledgeDisruption',
    requiredMarkers: [
      'createContext(tx)',
      'version: { increment: 1 }',
      'BookingDisruptionAcknowledgedEvent',
      'publisher.publish(eventsToPublish)',
    ],
  },
  {
    id: 'booking.disruption.accepted',
    source: 'disruption/api/disruption.service.ts',
    method: 'acceptDisruption',
    requiredMarkers: [
      'createContext(tx)',
      'version: { increment: 1 }',
      'BookingDisruptionAcceptedEvent',
      'publisher.publish(eventsToPublish)',
    ],
  },
  {
    id: 'refund.settled',
    source: 'refund-settlement/refund-settlement.service.ts',
    method: 'settleVerifiedOutcome',
    requiredMarkers: [
      'createContext(tx)',
      'RefundSettledEvent',
      'bookingLifecycleService.updateBookingRefundStatus',
      'eventsToPublish = [...context.events]',
      'publisher.publish(eventsToPublish)',
    ],
  },
  {
    id: 'booking.refund.retry',
    source: 'payment/payment-refund.service.ts',
    method: 'resolveEscalatedCancellationRefund',
    requiredMarkers: [
      'createContext(tx)',
      'bookingLifecycleService.updateBookingRefundStatus',
      'eventsToPublish = [...context.events]',
      'publisher.publish(eventsToPublish)',
    ],
  },
];

const MODULE_IMPORT_INVENTORY = [
  {
    module: 'booking-lifecycle/booking-state.module.ts',
    required: ['DomainEventsModule'],
    forbidden: [
      'BookingLifecycleModule',
      'CancellationModule',
      'DisruptionModule',
      'RefundSettlementModule',
    ],
  },
  {
    module: 'refund-settlement/refund-settlement.module.ts',
    required: ['BookingStateModule'],
    forbidden: ['BookingLifecycleModule'],
  },
  {
    module: 'disruption/disruption.module.ts',
    required: ['BookingStateModule'],
    forbidden: ['BookingLifecycleModule'],
  },
  {
    module: 'payment-fulfillment/payment-fulfillment.module.ts',
    required: ['PaymentMethodsModule', 'BookingLifecycleModule', 'DomainEventsModule'],
    forbidden: ['PaymentModule'],
  },
] as const;

function readProductionSource(relativePath: string): string {
  return readFileSync(join(__dirname, '..', 'src', relativePath), 'utf8');
}

function extractMethodSource(source: string, methodName: string): string {
  const methodPattern = new RegExp(
    `\\n  (?:(?:public|private|protected)\\s+)?(?:async\\s+)?${methodName}\\s*\\(`,
  );
  const start = source.search(methodPattern);
  if (start < 0) {
    throw new Error(`Could not find method ${methodName}`);
  }

  const remainder = source.slice(start + 1);
  const nextMethodPattern =
    /\n {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/;
  const nextMethod = remainder.search(nextMethodPattern);
  return source.slice(start, nextMethod < 0 ? source.length : start + 1 + nextMethod);
}

function countMarker(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

function collectProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectProductionTypeScriptFiles(entryPath);
    }
    return entry.name.endsWith('.ts') ? [entryPath] : [];
  });
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
      const fulfillmentGateway =
        moduleFixture.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT);
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
      expect(
        (saga as unknown as { fulfillmentGateway: unknown }).fulfillmentGateway,
      ).toBeInstanceOf(DuffelFulfillmentAdapter);
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
      const container = (
        moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } }
      ).container;
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
      const container = (
        moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } }
      ).container;
      const modulesMap = container.getModules();

      let paymentNestModule: {
        imports?: Set<unknown>;
        relatedModules?: Set<unknown>;
        metatype: Type<unknown>;
      } | null = null;
      let fulfillmentNestModule: {
        imports?: Set<unknown>;
        relatedModules?: Set<unknown>;
        metatype: Type<unknown>;
      } | null = null;

      for (const [, mod] of modulesMap) {
        const typed = mod as {
          imports?: Set<unknown>;
          relatedModules?: Set<unknown>;
          metatype: Type<unknown>;
        };
        if (typed.metatype === PaymentModule) paymentNestModule = typed;
        if (typed.metatype === PaymentFulfillmentModule) fulfillmentNestModule = typed;
      }

      expect(paymentNestModule).toBeDefined();
      expect(fulfillmentNestModule).toBeDefined();

      const getRelated = (m: {
        imports?: Set<unknown>;
        relatedModules?: Set<unknown>;
      }): Set<unknown> => m.relatedModules ?? m.imports ?? new Set();

      // BFS to find reachable modules from fulfillmentNestModule
      const reachableFromFulfillment = new Set<unknown>();
      const queue: unknown[] = [fulfillmentNestModule];

      while (queue.length > 0) {
        const curr = queue.shift() as {
          imports?: Set<unknown>;
          relatedModules?: Set<unknown>;
          metatype: Type<unknown>;
        };
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

  describe('5. Root AppModule Wiring & DI Architecture (US2 - T032)', () => {
    it('registers EventEmitterModule (or EventEmitterCoreModule) and BookingProjectionModule in AppModule', () => {
      const container = (
        moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } }
      ).container;
      const modulesMap = container.getModules();

      const registeredModuleNames: string[] = [];
      for (const [, nestModule] of modulesMap) {
        const typedModule = nestModule as { metatype?: Type<unknown> };
        if (typedModule.metatype?.name) {
          registeredModuleNames.push(typedModule.metatype.name);
        }
      }

      const hasEventEmitter =
        registeredModuleNames.includes('EventEmitterModule') ||
        registeredModuleNames.includes('EventEmitterCoreModule');
      expect(hasEventEmitter).toBe(true);
      expect(registeredModuleNames).toContain('BookingProjectionModule');

      // US2 Slice 2 deliverables are valid active modules
      expect(registeredModuleNames).toContain('BookingStateModule');
      expect(registeredModuleNames).toContain('DomainEventsModule');
    });

    it('registers EventEmitter2, BookingProjectionListener, BookingProjectionRepository, BookingProjectionService, and BookingEventHydratorService in AppModule', () => {
      const container = (
        moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } }
      ).container;
      const modulesMap = container.getModules();

      const allProviderKeys: string[] = [];
      for (const [, nestModule] of modulesMap) {
        const providers = (nestModule as { providers?: Map<unknown, unknown> }).providers;
        if (providers) {
          for (const [key] of providers) {
            if (typeof key === 'string') allProviderKeys.push(key);
            else if (typeof key === 'function' && key.name) {
              allProviderKeys.push(key.name);
              if (key === EventEmitter2) {
                allProviderKeys.push('EventEmitter2');
              }
            } else if (typeof key === 'symbol') allProviderKeys.push(key.toString());
          }
        }
      }

      expect(allProviderKeys).toContain('EventEmitter2');
      expect(allProviderKeys).toContain('BookingProjectionListener');
      expect(allProviderKeys).toContain('BookingProjectionRepository');
      expect(allProviderKeys).toContain('BookingProjectionService');
      expect(allProviderKeys).toContain('BookingEventHydratorService');

      // US2 Slice 2 deliverables are valid active providers
      expect(allProviderKeys).toContain('BookingEventPublisherService');
    });

    it('resolves EventEmitter2, BookingProjectionListener, BookingProjectionRepository, BookingProjectionService, and BookingEventHydratorService instances via DI', () => {
      expect(moduleFixture.get(EventEmitter2, { strict: false })).toBeDefined();
      expect(moduleFixture.get(BookingProjectionListener, { strict: false })).toBeDefined();
      expect(moduleFixture.get(BookingProjectionRepository, { strict: false })).toBeDefined();
      expect(moduleFixture.get(BookingProjectionService, { strict: false })).toBeDefined();
      expect(moduleFixture.get(BookingEventHydratorService, { strict: false })).toBeDefined();
    });
  });

  describe('6. BookingStateModule Single Registration and Acyclic Extraction (US2 - T019)', () => {
    it('registers BookingLifecycleService in exactly one module across all active modules in AppModule', () => {
      const container = (
        moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } }
      ).container;
      expect(container).toBeDefined();

      const modulesMap = container.getModules();
      expect(modulesMap.size).toBeGreaterThan(0);

      const modulesRegisteringService: string[] = [];

      for (const [, nestModule] of modulesMap) {
        const typedModule = nestModule as {
          metatype: Type<unknown>;
          providers: Map<unknown, unknown>;
        };

        if (typedModule.providers && typedModule.providers.has(BookingLifecycleService)) {
          const moduleName = typedModule.metatype ? typedModule.metatype.name : 'UnknownModule';
          modulesRegisteringService.push(moduleName);
        }
      }

      expect(modulesRegisteringService).toHaveLength(1);
      expect(modulesRegisteringService[0]).toBe('BookingStateModule');
    });

    it('declares BookingLifecycleService in BookingStateModule providers metadata, and NOT in BookingLifecycleModule providers metadata', () => {
      const stateProviders: unknown[] = Reflect.getMetadata('providers', BookingStateModule) || [];
      const lifecycleProviders: unknown[] =
        Reflect.getMetadata('providers', BookingLifecycleModule) || [];

      expect(stateProviders).toContain(BookingLifecycleService);
      expect(lifecycleProviders).not.toContain(BookingLifecycleService);
    });

    it('declares BookingLifecycleModule metadata imports and re-exports BookingStateModule, and does NOT register BookingLifecycleService in providers', () => {
      const lifecycleImports: unknown[] =
        Reflect.getMetadata('imports', BookingLifecycleModule) || [];
      const lifecycleExports: unknown[] =
        Reflect.getMetadata('exports', BookingLifecycleModule) || [];
      const lifecycleProviders: unknown[] =
        Reflect.getMetadata('providers', BookingLifecycleModule) || [];

      const unwrappedImports = lifecycleImports.map(unwrapModuleToken);
      const unwrappedExports = lifecycleExports.map(unwrapModuleToken);

      expect(unwrappedImports).toContain(BookingStateModule);
      expect(unwrappedExports).toContain(BookingStateModule);
      expect(lifecycleProviders).not.toContain(BookingLifecycleService);
    });

    it('resolves the identical singleton instance of BookingLifecycleService across AppModule, BookingLifecycleModule, and BookingStateModule', () => {
      const rootInstance = moduleFixture.get(BookingLifecycleService);
      const lifecycleInstance = moduleFixture
        .select(BookingLifecycleModule)
        .get(BookingLifecycleService);
      const stateInstance = moduleFixture.select(BookingStateModule).get(BookingLifecycleService);

      expect(rootInstance).toBeDefined();
      expect(rootInstance).toBe(lifecycleInstance);
      expect(lifecycleInstance).toBe(stateInstance);
    });

    it('proves BookingStateModule has zero direct or transitive imports of BookingLifecycleModule, CancellationModule, DisruptionModule, or RefundSettlementModule', () => {
      const transitiveImportsFromState = collectTransitiveStaticImports(BookingStateModule);

      expect(transitiveImportsFromState.has(BookingStateModule)).toBe(true);
      expect(transitiveImportsFromState.has(BookingLifecycleModule)).toBe(false);
      expect(transitiveImportsFromState.has(CancellationModule)).toBe(false);
      expect(transitiveImportsFromState.has(DisruptionModule)).toBe(false);
      expect(transitiveImportsFromState.has(RefundSettlementModule)).toBe(false);
    });

    it('allows downstream modules (cancellation, disruption, refund-settlement) to import BookingStateModule without circular reference to BookingLifecycleModule', async () => {
      const downstreamConsumerFixture = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            validate: (config) => envSchema.parse(config),
          }),
          BookingStateModule,
          RefundSettlementModule,
        ],
      }).compile();

      const service = downstreamConsumerFixture.get(BookingLifecycleService);
      expect(service).toBeDefined();

      const container = (
        downstreamConsumerFixture as unknown as {
          container: { getModules: () => Map<string, unknown> };
        }
      ).container;
      const registeredModuleNames: string[] = [];
      for (const [, nestModule] of container.getModules()) {
        const typedModule = nestModule as { metatype?: Type<unknown> };
        if (typedModule.metatype?.name) {
          registeredModuleNames.push(typedModule.metatype.name);
        }
      }

      expect(registeredModuleNames).toContain('BookingStateModule');
      expect(registeredModuleNames).not.toContain('BookingLifecycleModule');

      const downstreamPrisma = downstreamConsumerFixture.get(PrismaService, { strict: false });
      if (downstreamPrisma) {
        await downstreamPrisma.$disconnect();
      }
      await downstreamConsumerFixture.close();
    });

    it('verifies runtime NestContainer dependency graph has no link from BookingStateModule back to BookingLifecycleModule', () => {
      const container = (
        moduleFixture as unknown as { container: { getModules: () => Map<string, unknown> } }
      ).container;
      const modulesMap = container.getModules();

      let stateNestModule: {
        imports?: Set<unknown>;
        relatedModules?: Set<unknown>;
        metatype: Type<unknown>;
      } | null = null;
      let lifecycleNestModule: {
        imports?: Set<unknown>;
        relatedModules?: Set<unknown>;
        metatype: Type<unknown>;
      } | null = null;

      for (const [, mod] of modulesMap) {
        const typed = mod as {
          imports?: Set<unknown>;
          relatedModules?: Set<unknown>;
          metatype: Type<unknown>;
        };
        if (typed.metatype === BookingStateModule) stateNestModule = typed;
        if (typed.metatype === BookingLifecycleModule) lifecycleNestModule = typed;
      }

      expect(stateNestModule).toBeDefined();
      expect(lifecycleNestModule).toBeDefined();

      const getRelated = (m: {
        imports?: Set<unknown>;
        relatedModules?: Set<unknown>;
      }): Set<unknown> => m.relatedModules ?? m.imports ?? new Set();

      const reachableFromState = new Set<unknown>();
      const queue: unknown[] = [stateNestModule];

      while (queue.length > 0) {
        const curr = queue.shift() as {
          imports?: Set<unknown>;
          relatedModules?: Set<unknown>;
          metatype: Type<unknown>;
        };
        if (!curr || reachableFromState.has(curr)) continue;
        reachableFromState.add(curr);

        const related = getRelated(curr);
        for (const rel of related) {
          if (!reachableFromState.has(rel)) {
            queue.push(rel);
          }
        }
      }

      // Assert runtime container reachability: BookingLifecycleModule is NOT reachable from BookingStateModule
      expect(reachableFromState.has(lifecycleNestModule)).toBe(false);
    });
  });

  describe('7. Closure Inventory and Full Event-Driven Module Boot (T041)', () => {
    it('re-runs the complete mutation census with version and postcommit coverage', () => {
      for (const entry of MUTATION_INVENTORY) {
        const source = readProductionSource(entry.source);
        const methodSource = extractMethodSource(source, entry.method);

        for (const marker of entry.requiredMarkers) {
          expect(methodSource).toContain(marker);
        }

        for (const { marker, count } of entry.countMarkers ?? []) {
          expect(countMarker(methodSource, marker)).toBe(count);
        }
      }
    });

    it('finds no direct projection calls or projection imports in core mutation modules', () => {
      const coreRoots = [
        'booking-lifecycle',
        'cancellation',
        'disruption',
        'payment',
        'payment-fulfillment',
        'refund-settlement',
      ];
      const forbiddenProjectionReference =
        /BookingAgentProjectionService|bookingAgentProjectionService|BookingProjectionService|booking-projection|upsertProjection\s*\(/;
      const offenders: string[] = [];

      for (const root of coreRoots) {
        const rootSource = join(__dirname, '..', 'src', root);
        const files = collectProductionTypeScriptFiles(rootSource);

        for (const file of files) {
          if (file.endsWith('.spec.ts')) continue;
          const source = readFileSync(file, 'utf8');
          if (forbiddenProjectionReference.test(source)) {
            offenders.push(file);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it('keeps the extracted module import inventory acyclic', () => {
      for (const entry of MODULE_IMPORT_INVENTORY) {
        const source = readProductionSource(entry.module);

        for (const required of entry.required) {
          expect(source).toContain(required);
        }
        for (const forbidden of entry.forbidden) {
          expect(source).not.toContain(forbidden);
        }
      }
    });

    it('boots every event-driven module and resolves its production providers from AppModule', () => {
      const container = (
        moduleFixture as unknown as {
          container: { getModules: () => Map<string, unknown> };
        }
      ).container;
      const registeredModuleNames = new Set<string>();

      for (const [, nestModule] of container.getModules()) {
        const moduleName = (nestModule as { metatype?: Type<unknown> }).metatype?.name;
        if (moduleName) registeredModuleNames.add(moduleName);
      }

      const expectedModuleNames = [
        DomainEventsModule.name,
        IdempotencyModule.name,
        PaymentMethodsModule.name,
        PaymentFulfillmentModule.name,
        BookingStateModule.name,
        BookingLifecycleModule.name,
        BookingProjectionModule.name,
        CancellationModule.name,
        DisruptionModule.name,
        RefundSettlementModule.name,
      ];
      for (const moduleName of expectedModuleNames) {
        expect(registeredModuleNames).toContain(moduleName);
      }
      expect(
        registeredModuleNames.has('EventEmitterModule') ||
          registeredModuleNames.has('EventEmitterCoreModule'),
      ).toBe(true);

      const expectedProviders: Type<unknown>[] = [
        EventEmitter2,
        PaymentIdempotencyService,
        PaymentMethodService,
        PaymentFulfillmentSaga,
        BookingLifecycleService,
        BookingEventPublisherService,
        BookingProjectionListener,
        BookingProjectionRepository,
        BookingProjectionService,
        BookingProjectionMetrics,
        BookingProjectionReconciliationService,
        BookingEventHydratorService,
      ];
      for (const provider of expectedProviders) {
        expect(moduleFixture.get(provider, { strict: false })).toBeDefined();
      }
    });
  });
});
