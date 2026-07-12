import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import {
  PaymentStatus,
  RefundStatus,
  LedgerEntryType,
  PaymentEventSource,
  RefundTriggerType,
  PaymentMethodStatus,
} from '@shared/types';

describe('Payment Schema & Enums (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('should have new Prisma models registered on the client', async () => {
    // Attempting queries to verify models are registered (even if empty, they should not throw undefined property errors)
    expect(prisma.payment).toBeDefined();
    expect(prisma.idempotencyKey).toBeDefined();
    expect(prisma.paymentEvent).toBeDefined();
    expect(prisma.ledgerEntry).toBeDefined();
    expect(prisma.refund).toBeDefined();
    expect(prisma.paymentMethod).toBeDefined();

    // Verify findMany exists on each
    expect(typeof prisma.payment.findMany).toBe('function');
    expect(typeof prisma.idempotencyKey.findMany).toBe('function');
    expect(typeof prisma.paymentEvent.findMany).toBe('function');
    expect(typeof prisma.ledgerEntry.findMany).toBe('function');
    expect(typeof prisma.refund.findMany).toBe('function');
    expect(typeof prisma.paymentMethod.findMany).toBe('function');
  });

  it('should export correct types/enums from @shared/types', () => {
    expect(PaymentStatus).toBeDefined();
    expect(RefundStatus).toBeDefined();
    expect(LedgerEntryType).toBeDefined();
    expect(PaymentEventSource).toBeDefined();
    expect(RefundTriggerType).toBeDefined();
    expect(PaymentMethodStatus).toBeDefined();

    // Verify enum values mapping
    expect(PaymentStatus.CREATED).toBe('CREATED');
    expect(RefundStatus.REFUND_PENDING).toBe('REFUND_PENDING');
    expect(LedgerEntryType.DEBIT).toBe('DEBIT');
    expect(PaymentEventSource.WEBHOOK).toBe('WEBHOOK');
    expect(RefundTriggerType.SYSTEM_AUTOMATED).toBe('SYSTEM_AUTOMATED');
    expect(PaymentMethodStatus.ACTIVE).toBe('ACTIVE');
  });
});
