import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { CancellationService } from './cancellation.service';
import {
  CancelBookingDto,
  CancellationQuoteResponseDto,
  CancellationResponseDto,
  CancellationStatusResponseDto,
} from './cancellation.types';

type AuthenticatedRequest = Request & {
  user: { id: string };
};

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class CancellationController {
  constructor(
    private readonly cancellationService: CancellationService,
  ) {}

  @Get(':bookingId/cancellation')
  async getCancellationStatus(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
  ): Promise<CancellationStatusResponseDto> {
    return this.cancellationService.getCancellationStatus(bookingId, req.user.id);
  }

  @Post(':bookingId/cancellation-quote')
  async getCancellationQuote(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
  ): Promise<CancellationQuoteResponseDto> {
    return this.cancellationService.getCancellationQuote(bookingId, req.user.id);
  }

  @Post(':bookingId/cancel')
  async cancelBooking(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @Body() dto: CancelBookingDto,
  ): Promise<CancellationResponseDto> {
    return this.cancellationService.cancelBooking(bookingId, req.user.id, dto.quoteId);
  }
}
