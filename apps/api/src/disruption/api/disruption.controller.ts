import {
  Controller,
  Post,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Req,
  NotFoundException,
  ForbiddenException,
  ParseUUIDPipe,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService, SyncResult } from '../sync/supplier-sync.service';

import { DisruptionService } from './disruption.service';

export interface AuthenticatedRequest extends Request {
  user: { id: string; role: string };
}

@Controller('disruptions')
@UseGuards(JwtAuthGuard)
export class DisruptionController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supplierSyncService: SupplierSyncService,
  ) {}

  @Post('sync/:bookingId')
  @HttpCode(HttpStatus.OK)
  async syncBooking(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
  ): Promise<SyncResult> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.userId !== req.user.id && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Insufficient permissions');
    }

    return this.supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
  }
}

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class TravellerDisruptionController {
  constructor(private readonly disruptionService: DisruptionService) {}

  @Get(':bookingId/disruptions')
  async getDisruptions(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @Query() query: Record<string, unknown>,
  ) {
    for (const key of Object.keys(query)) {
      if (key.includes('[') || key.includes(']')) {
        throw new BadRequestException('Invalid query parameter format');
      }
      const val = query[key];
      if (typeof val !== 'string' && val !== undefined) {
        throw new BadRequestException(`Query parameter ${key} must be a single string`);
      }
    }

    const pageQuery = query.page as string | undefined;
    const limitQuery = query.limit as string | undefined;

    let page = 1;
    let limit = 20;

    if (pageQuery !== undefined) {
      const parsedPage = parseInt(pageQuery, 10);
      if (isNaN(parsedPage) || parsedPage < 1 || String(parsedPage) !== pageQuery.trim()) {
        throw new BadRequestException('Invalid page parameter');
      }
      page = parsedPage;
    }

    if (limitQuery !== undefined) {
      const parsedLimit = parseInt(limitQuery, 10);
      if (
        isNaN(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > 50 ||
        String(parsedLimit) !== limitQuery.trim()
      ) {
        throw new BadRequestException('Invalid limit parameter');
      }
      limit = parsedLimit;
    }

    return this.disruptionService.getDisruptionHistory(bookingId, req.user.id, page, limit);
  }

  @Post(':bookingId/disruptions/:revisionId/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledgeDisruption(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @Param('revisionId', new ParseUUIDPipe({ version: '4' })) revisionId: string,
  ) {
    return this.disruptionService.acknowledgeDisruption(bookingId, revisionId, req.user.id);
  }

  @Post(':bookingId/disruptions/:revisionId/accept')
  @HttpCode(HttpStatus.OK)
  async acceptDisruption(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @Param('revisionId', new ParseUUIDPipe({ version: '4' })) revisionId: string,
  ) {
    return this.disruptionService.acceptDisruption(bookingId, revisionId, req.user.id);
  }
}
