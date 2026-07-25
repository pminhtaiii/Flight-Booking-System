import { Test, TestingModule } from '@nestjs/testing';
import { DisruptionController } from './disruption.controller';
import { SupplierSyncService } from '../sync/supplier-sync.service';

describe('DisruptionController', () => {
  let controller: DisruptionController;
  let mockSupplierSyncService: { syncBooking: jest.Mock };

  beforeEach(async () => {
    mockSupplierSyncService = {
      syncBooking: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisruptionController],
      providers: [
        {
          provide: SupplierSyncService,
          useValue: mockSupplierSyncService,
        },
      ],
    }).compile();

    controller = module.get<DisruptionController>(DisruptionController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should call supplierSyncService.syncBooking with WEBHOOK source and return result', async () => {
    const bookingId = 'booking-123';
    const mockResult = { status: 'NO_CHANGE' };
    mockSupplierSyncService.syncBooking.mockResolvedValue(mockResult);

    const result = await controller.syncBooking(bookingId);

    expect(mockSupplierSyncService.syncBooking).toHaveBeenCalledWith(bookingId, 'WEBHOOK');
    expect(result).toBe(mockResult);
  });
});
