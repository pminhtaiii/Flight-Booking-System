import { Controller, Post, Get, Param, HttpCode, HttpStatus, UseGuards, Req, NotFoundException, ForbiddenException, ParseUUIDPipe, Query } from '@nestjs/common';
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
    @Query('page') pageQuery?: string,
    @Query('limit') limitQuery?: string,
  ) {
    const page = pageQuery ? Math.max(1, parseInt(pageQuery, 10)) : 1;
    const limit = limitQuery ? Math.min(50, Math.max(1, parseInt(limitQuery, 10))) : 20;
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

