import { Test, TestingModule } from '@nestjs/testing';
import { DuffelInboxService } from './duffel-inbox.service';
import { PrismaService } from '@/prisma/prisma.service';
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('DuffelInboxService', () => {
  let service: DuffelInboxService;

  const mockPrismaService = {
    duffelWebhookEvent: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DuffelInboxService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<DuffelInboxService>(DuffelInboxService);

    jest.clearAllMocks();
  });

  it('should insert a supported event as PENDING', async () => {
    mockPrismaService.duffelWebhookEvent.findUnique.mockResolvedValue(null);
    mockPrismaService.duffelWebhookEvent.create.mockImplementation(({ data }: { data: Prisma.DuffelWebhookEventCreateInput }) => Promise.resolve({ id: 'uuid-123', ...data }));

    const payload = { id: 'wev_1', type: 'order.airline_initiated_change_detected', data: { object: { order_id: 'ord_1' } } };
    const event = await service.createEvent('wev_1', 'idem_key', 'ord_1', 'order.airline_initiated_change_detected', payload);

    expect(event.supplierEventId).toBe('wev_1');
    expect(event.status).toBe('PENDING');
    expect(event.processedAt).toBeNull();
    expect(mockPrismaService.duffelWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          eventType: 'order.airline_initiated_change_detected',
        }),
      }),
    );
  });

  it('should insert an unsupported event as SKIPPED', async () => {
    mockPrismaService.duffelWebhookEvent.findUnique.mockResolvedValue(null);
    mockPrismaService.duffelWebhookEvent.create.mockImplementation(({ data }: { data: Prisma.DuffelWebhookEventCreateInput }) => Promise.resolve({ id: 'uuid-123', ...data }));

    const payload = { id: 'wev_2', type: 'unsupported.event' };
    const event = await service.createEvent('wev_2', null, null, 'unsupported.event', payload);

    expect(event.supplierEventId).toBe('wev_2');
    expect(event.status).toBe('SKIPPED');
    expect(event.processedAt).toBeInstanceOf(Date);
    expect(mockPrismaService.duffelWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SKIPPED',
          eventType: 'unsupported.event',
        }),
      }),
    );
  });

  it('should return existing event if duplicate delivery occurs', async () => {
    const existing = { id: 'uuid-123', supplierEventId: 'wev_1', status: 'PENDING' };
    mockPrismaService.duffelWebhookEvent.findUnique.mockResolvedValue(existing);

    const event = await service.createEvent('wev_1', 'idem_key', 'ord_1', 'order.airline_initiated_change_detected', {});

    expect(event).toEqual(existing);
    expect(mockPrismaService.duffelWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('should handle concurrency races by catching unique constraint error and returning existing event', async () => {
    mockPrismaService.duffelWebhookEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'uuid-123', supplierEventId: 'wev_1', status: 'PENDING' });

    const error = new Error('Unique constraint violation') as { code?: string; meta?: { target?: string[] } };
    error.code = 'P2002';
    error.meta = { target: ['supplierEventId'] };
    mockPrismaService.duffelWebhookEvent.create.mockRejectedValue(error);

    const event = await service.createEvent('wev_1', 'idem_key', 'ord_1', 'order.airline_initiated_change_detected', {});
    expect(event.id).toBe('uuid-123');
    expect(mockPrismaService.duffelWebhookEvent.findUnique).toHaveBeenCalledTimes(2);
  });

  it('should throw HttpException with HttpStatus.SERVICE_UNAVAILABLE on database write failure', async () => {
    mockPrismaService.duffelWebhookEvent.findUnique.mockResolvedValue(null);
    mockPrismaService.duffelWebhookEvent.create.mockRejectedValue(new Error('DB connection lost'));

    await expect(service.createEvent('wev_1', 'idem_key', 'ord_1', 'order.airline_initiated_change_detected', {})).rejects.toThrow(
      expect.objectContaining({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        response: expect.objectContaining({ error: 'WEBHOOK_INBOX_UNAVAILABLE' }),
      }),
    );
  });
});
