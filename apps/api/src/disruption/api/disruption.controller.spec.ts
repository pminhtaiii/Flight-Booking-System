import { Test, TestingModule } from '@nestjs/testing';
import { DisruptionController, AuthenticatedRequest } from './disruption.controller';
import { SupplierSyncService } from '../sync/supplier-sync.service';
import { PrismaService } from '@/prisma/prisma.service';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

describe('DisruptionController', () => {
  let controller: DisruptionController;
  let mockSupplierSyncService: { syncBooking: jest.Mock };
  let mockPrismaService: { booking: { findUnique: jest.Mock } };

  beforeEach(async () => {
    mockSupplierSyncService = {
      syncBooking: jest.fn(),
    };
    mockPrismaService = {
      booking: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DisruptionController],
      providers: [
        {
          provide: SupplierSyncService,
          useValue: mockSupplierSyncService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    controller = module.get<DisruptionController>(DisruptionController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('should throw NotFoundException if booking does not exist', async () => {
    mockPrismaService.booking.findUnique.mockResolvedValue(null);
    const req = { user: { id: 'user-123', role: 'USER' } } as unknown as AuthenticatedRequest;

    await expect(controller.syncBooking(req, 'booking-123')).rejects.toThrow(NotFoundException);
  });

  it('should throw ForbiddenException if user does not own booking and is not admin', async () => {
    mockPrismaService.booking.findUnique.mockResolvedValue({ id: 'booking-123', userId: 'owner-456' });
    const req = { user: { id: 'user-123', role: 'USER' } } as unknown as AuthenticatedRequest;

    await expect(controller.syncBooking(req, 'booking-123')).rejects.toThrow(ForbiddenException);
  });

  it('should succeed if user owns the booking', async () => {
    mockPrismaService.booking.findUnique.mockResolvedValue({ id: 'booking-123', userId: 'user-123' });
    const mockResult = { status: 'NO_CHANGE' };
    mockSupplierSyncService.syncBooking.mockResolvedValue(mockResult);
    const req = { user: { id: 'user-123', role: 'USER' } } as unknown as AuthenticatedRequest;

    const result = await controller.syncBooking(req, 'booking-123');

    expect(mockSupplierSyncService.syncBooking).toHaveBeenCalledWith('booking-123', 'WEBHOOK');
    expect(result).toBe(mockResult);
  });

  it('should succeed if user is an admin even if they do not own the booking', async () => {
    mockPrismaService.booking.findUnique.mockResolvedValue({ id: 'booking-123', userId: 'owner-456' });
    const mockResult = { status: 'REVISION_CREATED', revisionId: 'rev-789' };
    mockSupplierSyncService.syncBooking.mockResolvedValue(mockResult);
    const req = { user: { id: 'admin-123', role: 'ADMIN' } } as unknown as AuthenticatedRequest;

    const result = await controller.syncBooking(req, 'booking-123');

    expect(mockSupplierSyncService.syncBooking).toHaveBeenCalledWith('booking-123', 'WEBHOOK');
    expect(result).toBe(mockResult);
  });
});
