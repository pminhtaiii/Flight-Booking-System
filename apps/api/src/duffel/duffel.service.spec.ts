const mockGetOrder = jest.fn();
const mockConfirmCancellation = jest.fn();

jest.mock('@duffel/api', () => ({
  Duffel: jest.fn().mockImplementation(() => ({
    orders: {
      get: mockGetOrder,
    },
    orderCancellations: {
      confirm: mockConfirmCancellation,
    },
  })),
}));

import { CacheService } from '@/cache/cache.service';
import { HttpException, HttpStatus } from '@nestjs/common';
import { DuffelService } from './duffel.service';

describe('DuffelService cancellation recovery adapter', () => {
  let service: DuffelService;

  beforeEach(() => {
    mockGetOrder.mockReset();
    mockConfirmCancellation.mockReset();
    service = new DuffelService({} as CacheService);
  });

  it('retrieves an order and normalizes a remotely confirmed cancellation', async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        id: 'ord_123',
        cancelled_at: '2026-07-22T10:00:00.000Z',
        cancellation: { id: 'oc_123', confirmed_at: '2026-07-22T10:00:00.000Z' },
      },
    });

    await expect(service.retrieveOrder('ord_123')).resolves.toEqual({
      id: 'ord_123',
      order_id: 'ord_123',
      status: 'CANCELLED',
      cancelled_at: '2026-07-22T10:00:00.000Z',
      cancellation_id: 'oc_123',
    });
    expect(mockGetOrder).toHaveBeenCalledWith('ord_123');
  });

  it('normalizes an uncancelled order as active when Duffel omits cancelled_at', async () => {
    mockGetOrder.mockResolvedValue({
      data: {
        id: 'ord_active',
        cancellation: null,
      },
    });

    await expect(service.retrieveOrder('ord_active')).resolves.toMatchObject({
      id: 'ord_active',
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: null,
    });
  });

  it('confirms the supplied cancellation quote without creating another quote', async () => {
    mockConfirmCancellation.mockResolvedValue({
      data: {
        id: 'oc_123',
        order_id: 'ord_123',
        confirmed_at: '2026-07-22T10:00:00.000Z',
        refund_amount: '75.00',
        refund_currency: 'GBP',
      },
    });

    await expect(service.confirmCancellationQuote('oc_123')).resolves.toEqual({
      id: 'oc_123',
      order_id: 'ord_123',
      status: 'CONFIRMED',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      refundable: true,
      confirmed_at: '2026-07-22T10:00:00.000Z',
    });
    expect(mockConfirmCancellation).toHaveBeenCalledWith('oc_123');
  });

  it('translates upstream order retrieval failures into a PII-safe gateway error', async () => {
    mockGetOrder.mockRejectedValue(new Error('Duffel unavailable'));

    await expect(service.retrieveOrder('ord_123')).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: {
        code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
      },
    });
  });
});
