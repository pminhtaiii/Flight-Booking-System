import 'reflect-metadata';
import { BookingController } from './booking.controller';

describe('BookingController', () => {
  const bookingService = {
    listBookings: jest.fn(),
    getBookingDetail: jest.fn(),
  };
  const controller = new BookingController(bookingService as never);

  beforeEach(() => jest.clearAllMocks());

  it('uses the authenticated user and default list query values', async () => {
    bookingService.listBookings.mockResolvedValue({ bookings: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });

    await controller.listBookings({ user: { id: 'user-1' } } as never, { tab: 'upcoming', page: 1, limit: 20 });

    expect(bookingService.listBookings).toHaveBeenCalledWith('user-1', 'upcoming', 1, 20);
  });

  it('uses the authenticated user when requesting booking detail', async () => {
    bookingService.getBookingDetail.mockResolvedValue({ id: 'booking-1' });

    await controller.getBookingDetail({ user: { id: 'user-1' } } as never, '123e4567-e89b-42d3-a456-426614174000');

    expect(bookingService.getBookingDetail).toHaveBeenCalledWith('123e4567-e89b-42d3-a456-426614174000', 'user-1');
  });
});
