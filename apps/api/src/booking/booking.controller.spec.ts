import 'reflect-metadata';
import { BookingController } from './booking.controller';

describe('BookingController', () => {
  const bookingManagementService = {
    listBookings: jest.fn(),
    getBookingDetail: jest.fn(),
  };
  const cancellationService = {
    getCancellationStatus: jest.fn(),
    getCancellationQuote: jest.fn(),
    cancelBooking: jest.fn(),
  };
  const controller = new BookingController(
    bookingManagementService as never,
    cancellationService as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('uses the authenticated user and default list query values', async () => {
    bookingManagementService.listBookings.mockResolvedValue({
      bookings: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });

    await controller.listBookings({ user: { id: 'user-1' } } as never, {
      tab: 'upcoming',
      page: 1,
      limit: 20,
    });

    expect(bookingManagementService.listBookings).toHaveBeenCalledWith('user-1', 'upcoming', 1, 20);
  });

  it('uses the authenticated user when requesting booking detail', async () => {
    bookingManagementService.getBookingDetail.mockResolvedValue({ id: 'booking-1' });

    await controller.getBookingDetail(
      { user: { id: 'user-1' } } as never,
      '123e4567-e89b-42d3-a456-426614174000',
    );

    expect(bookingManagementService.getBookingDetail).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000',
      'user-1',
    );
  });

  it('delegates getCancellationStatus to cancellationService', async () => {
    cancellationService.getCancellationStatus.mockResolvedValue({ bookingId: 'booking-1' });

    await controller.getCancellationStatus(
      { user: { id: 'user-1' } } as never,
      '123e4567-e89b-42d3-a456-426614174000',
    );

    expect(cancellationService.getCancellationStatus).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000',
      'user-1',
    );
  });

  it('delegates getCancellationQuote to cancellationService', async () => {
    cancellationService.getCancellationQuote.mockResolvedValue({ quoteId: 'quote-1' });

    await controller.getCancellationQuote(
      { user: { id: 'user-1' } } as never,
      '123e4567-e89b-42d3-a456-426614174000',
    );

    expect(cancellationService.getCancellationQuote).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000',
      'user-1',
    );
  });

  it('delegates cancelBooking to cancellationService', async () => {
    cancellationService.cancelBooking.mockResolvedValue({
      bookingId: 'booking-1',
      cancellationStatus: 'CANCELLED',
    });

    await controller.cancelBooking(
      { user: { id: 'user-1' } } as never,
      '123e4567-e89b-42d3-a456-426614174000',
      { quoteId: 'quote-1' },
    );

    expect(cancellationService.cancelBooking).toHaveBeenCalledWith(
      '123e4567-e89b-42d3-a456-426614174000',
      'user-1',
      'quote-1',
    );
  });
});
