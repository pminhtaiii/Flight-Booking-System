import { Controller, Post, Param, HttpCode, HttpStatus, UseGuards, Req, NotFoundException, ForbiddenException, ParseUUIDPipe } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService, SyncResult } from '../sync/supplier-sync.service';

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
