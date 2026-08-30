import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { BookingIntentCron } from './booking-intent.cron';
import { BookingIntentService } from './booking-intent.service';

describe('BookingIntentCron', () => {
  let cron: BookingIntentCron;
  let mockBookingIntentService: {
    expireExpiredIntents: jest.Mock;
    deleteExpiredIntents: jest.Mock;
  };
  let loggerErrorSpy: jest.SpyInstance;
  let loggerLogSpy: jest.SpyInstance;

  beforeEach(() => {
    mockBookingIntentService = {
      expireExpiredIntents: jest.fn(),
      deleteExpiredIntents: jest.fn(),
    };

    cron = new BookingIntentCron(mockBookingIntentService as unknown as BookingIntentService);

    // Spy on logger calls
    loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    loggerLogSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('handleExpiration', () => {
    it('calls expireExpiredIntents and logs success', async () => {
      mockBookingIntentService.expireExpiredIntents.mockResolvedValueOnce({
        expiredCount: 2,
      });

      await cron.handleExpiration();

      expect(mockBookingIntentService.expireExpiredIntents).toHaveBeenCalled();
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting booking intent expiration cron'),
      );
      expect(loggerLogSpy).toHaveBeenCalledWith(expect.stringContaining('Expired 2 intents in'));
    });

    it('logs error if expireExpiredIntents throws', async () => {
      const error = new Error('Database connection failed');
      mockBookingIntentService.expireExpiredIntents.mockRejectedValueOnce(error);

      await cron.handleExpiration();

      expect(mockBookingIntentService.expireExpiredIntents).toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error occurred during booking intent expiration execution:'),
        error,
      );
    });
  });

  describe('handleHardDelete', () => {
    it('calls deleteExpiredIntents and logs success', async () => {
      mockBookingIntentService.deleteExpiredIntents.mockResolvedValueOnce({
        deletedCount: 1,
      });

      await cron.handleHardDelete();

      expect(mockBookingIntentService.deleteExpiredIntents).toHaveBeenCalled();
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Starting booking intent hard-delete cron'),
      );
      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('Hard-deleted 1 intents in'),
      );
    });

    it('logs error if deleteExpiredIntents throws', async () => {
      const error = new Error('Database connection failed');
      mockBookingIntentService.deleteExpiredIntents.mockRejectedValueOnce(error);

      await cron.handleHardDelete();

      expect(mockBookingIntentService.deleteExpiredIntents).toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error occurred during booking intent hard-delete execution:'),
        error,
      );
    });
  });
});
