import { ParseUUIDPipe, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { CancellationController } from './cancellation.controller';
import { CancellationService } from './cancellation.service';
import { CancelBookingDto } from './cancellation.types';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';

describe('CancellationController', () => {
  let controller: CancellationController;
  let service: jest.Mocked<CancellationService>;

  beforeEach(async () => {
    service = {
      getCancellationStatus: jest.fn(),
      getCancellationQuote: jest.fn(),
      cancelBooking: jest.fn(),
    } as unknown as jest.Mocked<CancellationService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CancellationController],
      providers: [
        {
          provide: CancellationService,
          useValue: service,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<CancellationController>(CancellationController);
  });

  describe('routing metadata', () => {
    it('mounts controller under bookings/:bookingId/cancellation', () => {
      const controllerPath = Reflect.getMetadata(PATH_METADATA, CancellationController);
      expect(controllerPath).toBe('bookings/:bookingId/cancellation');
    });

    it('mounts getCancellationStatus at root of controller sub-resource', () => {
      const path = Reflect.getMetadata(PATH_METADATA, controller.getCancellationStatus);
      expect(['', '/', undefined]).toContain(path);
    });

    it('mounts getCancellationQuote at quote sub-path', () => {
      const path = Reflect.getMetadata(PATH_METADATA, controller.getCancellationQuote);
      expect(path).toBe('quote');
    });

    it('mounts cancelBooking at root of controller sub-resource', () => {
      const path = Reflect.getMetadata(PATH_METADATA, controller.cancelBooking);
      expect(['', '/', undefined]).toContain(path);
    });
  });

  describe('guard and pipe metadata', () => {
    it('has JwtAuthGuard applied via Reflector / GUARDS metadata', () => {
      const reflector = new Reflector();
      const guards = reflector.get(GUARDS_METADATA, CancellationController);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
    });

    it('applies ParseUUIDPipe to bookingId param on cancellation endpoints', () => {
      const methods = ['getCancellationStatus', 'getCancellationQuote', 'cancelBooking'] as const;

      for (const method of methods) {
        const routeArgs = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          CancellationController,
          method,
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
      }
    });
  });

  it('delegates getCancellationStatus with bookingId and user id', async () => {
    const mockStatus = { isEligible: true } as any;
    service.getCancellationStatus.mockResolvedValue(mockStatus);

    const req = { user: { id: 'user-123' } } as any;
    const result = await controller.getCancellationStatus(req, 'b-123');

    expect(result).toBe(mockStatus);
    expect(service.getCancellationStatus).toHaveBeenCalledWith('b-123', 'user-123');
  });

  it('delegates getCancellationQuote with bookingId and user id', async () => {
    const mockQuote = { quoteId: 'q-123' } as any;
    service.getCancellationQuote.mockResolvedValue(mockQuote);

    const req = { user: { id: 'user-123' } } as any;
    const result = await controller.getCancellationQuote(req, 'b-123');

    expect(result).toBe(mockQuote);
    expect(service.getCancellationQuote).toHaveBeenCalledWith('b-123', 'user-123');
  });

  it('delegates cancelBooking with bookingId, user id, and quoteId from body', async () => {
    const mockResponse = { bookingId: 'b-123', refundAmount: 100 } as any;
    service.cancelBooking.mockResolvedValue(mockResponse);

    const req = { user: { id: 'user-123' } } as any;
    const result = await controller.cancelBooking(req, 'b-123', { quoteId: 'q-123' });

    expect(result).toBe(mockResponse);
    expect(service.cancelBooking).toHaveBeenCalledWith('b-123', 'user-123', 'q-123');
  });

  describe('CancelBookingDto Validation', () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    it('accepts valid quoteId payload', async () => {
      const result = await pipe.transform(
        { quoteId: 'quote-123' },
        { type: 'body', metatype: CancelBookingDto },
      );
      expect(result).toEqual({ quoteId: 'quote-123' });
    });

    it('rejects missing or empty quoteId', async () => {
      await expect(
        pipe.transform({}, { type: 'body', metatype: CancelBookingDto }),
      ).rejects.toThrow();

      await expect(
        pipe.transform({ quoteId: '' }, { type: 'body', metatype: CancelBookingDto }),
      ).rejects.toThrow();
    });

    it('rejects non-string quoteId', async () => {
      await expect(
        pipe.transform({ quoteId: 12345 }, { type: 'body', metatype: CancelBookingDto }),
      ).rejects.toThrow();
    });

    it('rejects non-whitelisted extra fields', async () => {
      await expect(
        pipe.transform(
          { quoteId: 'quote-123', extraField: 'invalid' },
          { type: 'body', metatype: CancelBookingDto },
        ),
      ).rejects.toThrow();
    });
  });
});
