import { Test, TestingModule } from '@nestjs/testing';
import { FlightsController } from './flights.controller';
import { FlightsService } from './flights.service';
import { FlightSearchRequestDto, FlightSearchResponseDto } from './dto/search-flight.dto';
import { Response } from 'express';

describe('FlightsController (T037)', () => {
  let controller: FlightsController;
  let flightsService: { search: jest.Mock; getFlightDetail: jest.Mock };

  beforeEach(async () => {
    flightsService = {
      search: jest.fn(),
      getFlightDetail: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FlightsController],
      providers: [{ provide: FlightsService, useValue: flightsService }],
    }).compile();

    controller = module.get<FlightsController>(FlightsController);
  });

  describe('search', () => {
    it('sets Cache-Control header to private, no-store and strips ETag header', async () => {
      const mockResponse = {
        setHeader: jest.fn(),
        removeHeader: jest.fn(),
      } as unknown as Response;

      const mockBody: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      const mockReq = {
        user: { id: 'usr_123', email: 'test@example.com' },
      } as any;

      const mockHeaders = {
        'x-trace-id': 'trace-123',
        'x-correlation-id': 'corr-456',
      };

      const expectedResponse: FlightSearchResponseDto = {
        mode: 'MATCHED',
        results: [],
        meta: {
          totalResults: 0,
          searchHash: 'hash-abc',
          cached: false,
          requestedCabinClass: 'economy',
        },
      };

      flightsService.search.mockResolvedValue(expectedResponse);

      const result = await controller.search(mockBody, mockReq, mockHeaders, mockResponse);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
      expect(mockResponse.removeHeader).toHaveBeenCalledWith('ETag');
      expect(flightsService.search).toHaveBeenCalledWith(
        'usr_123',
        mockBody,
        'trace-123',
        'corr-456',
      );
      expect(result).toEqual(expectedResponse);
      expect(result.mode).toBe('MATCHED');
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('meta');
    });

    it('handles fallback from x-trace-id to x-correlation-id', async () => {
      const mockResponse = {
        setHeader: jest.fn(),
        removeHeader: jest.fn(),
      } as unknown as Response;

      const mockBody: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      const mockReq = {
        user: { id: 'usr_123', email: 'test@example.com' },
      } as any;

      const mockHeaders = {
        'x-correlation-id': 'corr-789',
      };

      flightsService.search.mockResolvedValue({
        mode: 'MATCHED',
        results: [],
        meta: { totalResults: 0, searchHash: 'h', cached: false, requestedCabinClass: 'economy' },
      });

      await controller.search(mockBody, mockReq, mockHeaders, mockResponse);

      expect(flightsService.search).toHaveBeenCalledWith(
        'usr_123',
        mockBody,
        'corr-789',
        'corr-789',
      );
    });

    it('handles response where removeHeader is undefined without throwing', async () => {
      const mockResponse = {
        setHeader: jest.fn(),
      } as unknown as Response;

      const mockBody: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      const mockReq = {
        user: { id: 'usr_123', email: 'test@example.com' },
      } as any;

      flightsService.search.mockResolvedValue({
        mode: 'MATCHED',
        results: [],
        meta: { totalResults: 0, searchHash: 'h', cached: false, requestedCabinClass: 'economy' },
      });

      await expect(
        controller.search(mockBody, mockReq, {}, mockResponse),
      ).resolves.toBeDefined();
      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    });
  });

  describe('findOne', () => {
    it('delegates to flightsService.getFlightDetail', async () => {
      const mockReq = {
        user: { id: 'usr_123', email: 'test@example.com' },
      } as any;

      const mockDetail = { id: 'flight_1' } as any;
      flightsService.getFlightDetail.mockResolvedValue(mockDetail);

      const result = await controller.findOne('flight_1', mockReq);

      expect(flightsService.getFlightDetail).toHaveBeenCalledWith('flight_1', 'usr_123');
      expect(result).toBe(mockDetail);
    });
  });
});
