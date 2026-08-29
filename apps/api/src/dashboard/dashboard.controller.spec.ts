import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from '@shared/types';

describe('DashboardController (T010)', () => {
  let controller: DashboardController;
  let dashboardService: {
    getSummary: jest.Mock;
  };
  let mockResponse: {
    setHeader: jest.Mock;
  };

  const sampleSummary: DashboardSummary = {
    stats: {
      totalBookings: 8,
      upcomingBookings: 2,
      completedBookings: 5,
      cancelledBookings: 1,
    },
    recentBookings: [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        status: 'CONFIRMED',
        createdAt: '2026-08-28T12:00:00.000Z',
        departureAt: '2026-09-15T08:30:00.000Z',
        originCode: 'LHR',
        destinationCode: 'JFK',
        airlineCode: 'BA',
        flightNumber: 'BA178',
      },
    ],
    generatedAt: '2026-08-29T10:00:00.000Z',
  };

  beforeEach(() => {
    dashboardService = {
      getSummary: jest.fn().mockResolvedValue(sampleSummary),
    };
    mockResponse = {
      setHeader: jest.fn(),
    };
    controller = new DashboardController(dashboardService as unknown as DashboardService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Guard Protection', () => {
    it('has @UseGuards(JwtAuthGuard) attached at class or method level', () => {
      // Check class-level guards metadata
      const classGuards = Reflect.getMetadata(GUARDS_METADATA, DashboardController) ?? [];
      // Check method-level guards metadata for getSummary
      const methodGuards =
        Reflect.getMetadata(
          GUARDS_METADATA,
          DashboardController.prototype.getSummary ?? DashboardController.prototype,
        ) ?? [];

      const allGuards = [...classGuards, ...methodGuards];
      expect(allGuards.length).toBeGreaterThan(0);
      expect(
        allGuards.some((guard) => guard === JwtAuthGuard || guard.name === 'JwtAuthGuard'),
      ).toBe(true);
    });
  });

  describe('Authentication & User Identity Delegation', () => {
    it('extracts req.user.id from authenticated request and delegates to dashboardService.getSummary(userId)', async () => {
      const req = {
        user: { id: 'user-uuid-1111' },
      };

      const result = await controller.getSummary(req as never, mockResponse as unknown as Response);

      expect(dashboardService.getSummary).toHaveBeenCalledWith('user-uuid-1111');
      expect(result).toEqual(sampleSummary);
    });

    it('extracts req.user.sub if req.user.id is absent and delegates to dashboardService.getSummary(userId)', async () => {
      const req = {
        user: { sub: 'user-sub-2222' },
      };

      const result = await controller.getSummary(req as never, mockResponse as unknown as Response);

      expect(dashboardService.getSummary).toHaveBeenCalledWith('user-sub-2222');
      expect(result).toEqual(sampleSummary);
    });

    it('throws UnauthorizedException if req.user is missing', async () => {
      const req = {};

      await expect(
        controller.getSummary(req as never, mockResponse as unknown as Response),
      ).rejects.toThrow(UnauthorizedException);

      expect(dashboardService.getSummary).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException if req.user is empty without id or sub', async () => {
      const req = { user: {} };

      await expect(
        controller.getSummary(req as never, mockResponse as unknown as Response),
      ).rejects.toThrow(UnauthorizedException);

      expect(dashboardService.getSummary).not.toHaveBeenCalled();
    });
  });

  describe('Cache-Control & Security Headers', () => {
    it('sets Cache-Control: no-store, private header on the response', async () => {
      const req = {
        user: { id: 'user-uuid-1111' },
      };

      await controller.getSummary(req as never, mockResponse as unknown as Response);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    });
  });

  describe('Contract Conformance', () => {
    it('returns the exact DashboardSummary shape returned by DashboardService', async () => {
      const req = {
        user: { id: 'user-uuid-1111' },
      };

      const result = await controller.getSummary(req as never, mockResponse as unknown as Response);

      expect(result).toEqual(sampleSummary);
      expect(result.stats).toBeDefined();
      expect(result.recentBookings).toBeDefined();
      expect(result.generatedAt).toBeDefined();
      expect(result.stats.totalBookings).toBe(8);
      expect(result.stats.upcomingBookings).toBe(2);
      expect(result.stats.completedBookings).toBe(5);
      expect(result.stats.cancelledBookings).toBe(1);
    });
  });
});
