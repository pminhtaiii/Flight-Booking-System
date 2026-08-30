import { Test, TestingModule } from '@nestjs/testing';
import { DuffelEventProcessor } from './duffel-event.processor';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService } from '../sync/supplier-sync.service';
import { DuffelProcessorHealthService } from './duffel-processor-health.service';
import { DuffelWebhookEvent, Prisma } from '@prisma/client';

describe('DuffelEventProcessor', () => {
  let processor: DuffelEventProcessor;

  const mockPrismaService = {
    booking: {
      findFirst: jest.fn(),
    },
    duffelWebhookEvent: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const mockSupplierSyncService = {
    syncBooking: jest.fn(),
  };

  const mockHealthService = {
    recordHeartbeat: jest.fn(),
    recordSuccess: jest.fn(),
    getHealthMetrics: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuffelEventProcessor,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: SupplierSyncService, useValue: mockSupplierSyncService },
        { provide: DuffelProcessorHealthService, useValue: mockHealthService },
      ],
    }).compile();

    processor = module.get<DuffelEventProcessor>(DuffelEventProcessor);

    jest.clearAllMocks();
  });

  describe('claimEvents', () => {
    it('should query and claim pending and retry-scheduled events', async () => {
      const pendingEvent = {
        id: 'evt_1',
        status: 'PENDING',
        attempts: 0,
        processingToken: null,
      } as unknown as DuffelWebhookEvent;
      mockPrismaService.duffelWebhookEvent.findMany.mockResolvedValue([pendingEvent]);
      mockPrismaService.duffelWebhookEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaService.duffelWebhookEvent.findUnique.mockResolvedValue({
        ...pendingEvent,
        status: 'PROCESSING',
        attempts: 1,
      });

      const claimed = await processor.claimEvents(5);
      expect(claimed.length).toBe(1);
      expect(claimed[0].event.id).toBe('evt_1');
      expect(claimed[0].token).toBeTruthy();
      expect(mockPrismaService.duffelWebhookEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'evt_1',
          }),
        }),
      );
    });

    it('should claim stale processing events (> 5 minutes old)', async () => {
      const staleEvent = {
        id: 'evt_2',
        status: 'PROCESSING',
        processingStartedAt: new Date(Date.now() - 6 * 60 * 1000),
        processingToken: 'old_token',
        attempts: 1,
      } as unknown as DuffelWebhookEvent;
      mockPrismaService.duffelWebhookEvent.findMany.mockResolvedValue([staleEvent]);
      mockPrismaService.duffelWebhookEvent.updateMany.mockResolvedValue({ count: 1 });
      mockPrismaService.duffelWebhookEvent.findUnique.mockResolvedValue({
        ...staleEvent,
        attempts: 2,
      });

      const claimed = await processor.claimEvents(5);
      expect(claimed.length).toBe(1);
      expect(claimed[0].event.id).toBe('evt_2');
    });
  });

  describe('processInboxBatch', () => {
    it('should process events independently in a batch', async () => {
      const event1 = {
        id: 'evt_1',
        supplierEventId: 'wev_1',
        duffelOrderId: 'ord_1',
        status: 'PROCESSING',
        attempts: 1,
      } as unknown as DuffelWebhookEvent;
      const event2 = {
        id: 'evt_2',
        supplierEventId: 'wev_2',
        duffelOrderId: 'ord_2',
        status: 'PROCESSING',
        attempts: 1,
      } as unknown as DuffelWebhookEvent;

      jest.spyOn(processor, 'claimEvents').mockResolvedValue([
        { event: event1, token: 'token_1' },
        { event: event2, token: 'token_2' },
      ]);

      mockPrismaService.booking.findFirst
        .mockResolvedValueOnce({ id: 'bk_1' })
        .mockResolvedValueOnce({ id: 'bk_2' });

      mockSupplierSyncService.syncBooking
        .mockResolvedValueOnce({ status: 'REVISION_CREATED' })
        .mockRejectedValueOnce(new Error('Sync failed'));

      const spySuccess = jest.spyOn(processor, 'handleSuccess').mockResolvedValue();
      const spyFailure = jest.spyOn(processor, 'handleFailure').mockResolvedValue();

      await processor.processInboxBatch();

      expect(mockSupplierSyncService.syncBooking).toHaveBeenCalledTimes(2);
      expect(spySuccess).toHaveBeenCalledWith('evt_1', 'token_1');
      expect(spyFailure).toHaveBeenCalledWith('evt_2', 'token_2', expect.any(Error), 1);
    });
  });

  describe('Retry delay calculation', () => {
    it('should return correct retry delay minutes for attempt counts', () => {
      expect(processor.getRetryDelayMinutes(1)).toBe(1);
      expect(processor.getRetryDelayMinutes(2)).toBe(5);
      expect(processor.getRetryDelayMinutes(3)).toBe(15);
      expect(processor.getRetryDelayMinutes(4)).toBe(15);
      expect(processor.getRetryDelayMinutes(5)).toBeNull();
    });
  });

  describe('Retention cleanup', () => {
    it('should update rawPayload to DbNull for events older than 30 days', async () => {
      mockPrismaService.duffelWebhookEvent.updateMany.mockResolvedValue({ count: 5 });
      process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR = 'true';

      await processor.handleRetentionRedaction();

      expect(mockPrismaService.duffelWebhookEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            rawPayload: { not: Prisma.DbNull },
          }),
          data: expect.objectContaining({
            rawPayload: Prisma.DbNull,
            payloadRedactedAt: expect.any(Date),
          }),
        }),
      );
    });
  });
});
