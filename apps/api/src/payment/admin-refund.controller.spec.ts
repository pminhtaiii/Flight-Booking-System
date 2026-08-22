import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { AdminRefundController } from './admin-refund.controller';
import { PaymentRefundService } from './payment-refund.service';
import { RefundResolutionAction } from './dto/resolve-refund.dto';

describe('AdminRefundController', () => {
  let controller: AdminRefundController;
  let paymentRefundService: jest.Mocked<Partial<PaymentRefundService>>;

  beforeEach(async () => {
    paymentRefundService = {
      resolveEscalatedCancellationRefund: jest.fn(),
      listEscalatedRefunds: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminRefundController],
      providers: [
        {
          provide: PaymentRefundService,
          useValue: paymentRefundService,
        },
      ],
    }).compile();

    controller = module.get<AdminRefundController>(AdminRefundController);
  });

  it('delegates resolveRefund to paymentRefundService with actorId from req.user', async () => {
    (paymentRefundService.resolveEscalatedCancellationRefund as jest.Mock).mockResolvedValue({
      refundId: 'ref_123',
      refundStatus: 'SUCCEEDED',
      bookingStatus: 'CANCELLED_AND_REFUNDED',
    });

    const mockReq = { user: { id: 'admin_user_99' } };
    const result = await controller.resolveRefund(
      'ref_123',
      { action: 'MARK_RESOLVED_MANUALLY' as RefundResolutionAction },
      mockReq,
    );

    expect(result).toEqual({
      refundId: 'ref_123',
      refundStatus: 'SUCCEEDED',
      bookingStatus: 'CANCELLED_AND_REFUNDED',
    });
    expect(paymentRefundService.resolveEscalatedCancellationRefund).toHaveBeenCalledWith(
      'ref_123',
      'MARK_RESOLVED_MANUALLY',
      'admin_user_99',
    );
  });

  it('delegates getEscalatedRefunds to paymentRefundService', async () => {
    const mockList = [
      { id: 'ref_1', status: 'REFUND_FAILED_NEEDS_ATTENTION' },
    ];
    (paymentRefundService.listEscalatedRefunds as jest.Mock).mockResolvedValue(mockList as any);

    const result = await controller.getEscalatedRefunds();

    expect(result).toEqual(mockList);
    expect(paymentRefundService.listEscalatedRefunds).toHaveBeenCalled();
  });
});
