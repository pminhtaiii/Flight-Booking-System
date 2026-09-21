import { ParseUUIDPipe } from '@nestjs/common';
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingManagementController } from './booking-management.controller';
import { BookingManagementService } from './booking-management.service';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';

describe('BookingManagementController', () => {
  let controller: BookingManagementController;
  let service: jest.Mocked<BookingManagementService>;

  beforeEach(async () => {
    service = {
      listBookings: jest.fn(),
      getBookingDetail: jest.fn(),
    } as unknown as jest.Mocked<BookingManagementService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BookingManagementController],
      providers: [
        {
          provide: BookingManagementService,
          useValue: service,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BookingManagementController>(BookingManagementController);
  });

  describe('guard and pipe metadata', () => {
    it('has JwtAuthGuard applied via Reflector / GUARDS metadata', () => {
      const reflector = new Reflector();
      const guards = reflector.get(GUARDS_METADATA, BookingManagementController);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
    });

    it('applies ParseUUIDPipe to bookingId param on getBookingDetail', () => {
      const routeArgs = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        BookingManagementController,
        'getBookingDetail',
      );
      expect(routeArgs).toBeDefined();

      const bookingIdArg = Object.values(routeArgs).find(
        (arg: any) => arg.data === 'bookingId',
      ) as { pipes?: any[] } | undefined;

      expect(bookingIdArg).toBeDefined();
      const hasParseUuidPipe = bookingIdArg?.pipes?.some(
        (pipe) => pipe instanceof ParseUUIDPipe || pipe === ParseUUIDPipe,
      );
      expect(hasParseUuidPipe).toBe(true);
    });
  });

  it('delegates listBookings with authenticated user id and query parameters', async () => {
    const mockResult = { items: [], total: 0, page: 1, limit: 10, totalPages: 0 };
    service.listBookings.mockResolvedValue(mockResult as any);

    const req = { user: { id: 'user-123' } } as any;
    const query = { tab: 'upcoming' as const, page: 1, limit: 10 };

    const result = await controller.listBookings(req, query);

    expect(result).toBe(mockResult);
    expect(service.listBookings).toHaveBeenCalledWith('user-123', 'upcoming', 1, 10);
  });

  it('delegates getBookingDetail with bookingId and authenticated user id', async () => {
    const mockDetail = { id: 'b-123', status: 'CONFIRMED' } as any;
    service.getBookingDetail.mockResolvedValue(mockDetail);

    const req = { user: { id: 'user-123' } } as any;
    const result = await controller.getBookingDetail(req, 'b-123');

    expect(result).toBe(mockDetail);
    expect(service.getBookingDetail).toHaveBeenCalledWith('b-123', 'user-123');
  });
});
