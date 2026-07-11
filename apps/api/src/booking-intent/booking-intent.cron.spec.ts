import 'reflect-metadata';
import { BookingIntentCron } from './booking-intent.cron';

describe('BookingIntentCron', () => {
  let cron: BookingIntentCron;
  let mockBookingIntentService: any;
  let loggerErrorSpy: jest.SpyInstance;
  let loggerLogSpy: jest.SpyInstance;

  beforeEach(() => {
    mockBookingIntentService = {
      expireExpiredIntents: jest.fn(),
      deleteExpiredIntents: jest.fn(),
    };

    cron = new BookingIntentCron(mockBookingIntentService as any);

    // Spy on logger calls
    loggerErrorSpy = jest.spyOn((cron as any).logger, 'error').mockImplementation(() => {});
    loggerLogSpy = jest.spyOn((cron as any).logger, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleExpiration', () => {
    it('calls expireExpiredIntents and logs success', async () => {
      mockBookingIntentService.expireExpiredIntents.mockResolvedValueOnce({
        expiredCount: 2,
        expiredIds: ['id-1', 'id-2'],
      });

      await cron.handleExpiration();

      expect(mockBookingIntentService.expireExpiredIntents).toHaveBeenCalled();
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting booking intent expiration cron')
      );
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Expired 2 intents in')
      );
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Expired IDs: ["id-1","id-2"]')
      );
    });

    it('logs error if expireExpiredIntents throws', async () => {
      const error = new Error('Database connection failed');
      mockBookingIntentService.expireExpiredIntents.mockRejectedValueOnce(error);

      await cron.handleExpiration();

      expect(mockBookingIntentService.expireExpiredIntents).toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error occurred during booking intent expiration execution:'),
        error
      );
    });
  });

  describe('handleHardDelete', () => {
    it('calls deleteExpiredIntents and logs success', async () => {
      mockBookingIntentService.deleteExpiredIntents.mockResolvedValueOnce({
        deletedCount: 1,
        deletedIds: ['id-3'],
      });

      await cron.handleHardDelete();

      expect(mockBookingIntentService.deleteExpiredIntents).toHaveBeenCalled();
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting booking intent hard-delete cron')
      );
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Hard-deleted 1 intents in')
      );
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Deleted IDs: ["id-3"]')
      );
    });

    it('logs error if deleteExpiredIntents throws', async () => {
      const error = new Error('Database connection failed');
      mockBookingIntentService.deleteExpiredIntents.mockRejectedValueOnce(error);

      await cron.handleHardDelete();

      expect(mockBookingIntentService.deleteExpiredIntents).toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error occurred during booking intent hard-delete execution:'),
        error
      );
    });
  });
});
