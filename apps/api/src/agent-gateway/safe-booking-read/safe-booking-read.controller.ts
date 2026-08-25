import {
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from '../auth/agent-api-key.guard';
import { ClaimTokenGuard } from '../auth/claim-token.guard';
import { SafeBookingReadService } from './safe-booking-read.service';
import { UserBookingsResponseDto } from '../dto/user-bookings.dto';
import { BookingSummariesResponseDto } from '../dto/booking-summary.dto';
import { BookingDetailDto } from '../dto/booking-detail.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class SafeBookingReadController {
  private readonly logger = new Logger(SafeBookingReadController.name);

  constructor(private readonly safeBookingReadService: SafeBookingReadService) {}

  @Get('users/bookings')
  async getUserBookings(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<UserBookingsResponseDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.safeBookingReadService.getUserBookings(
        userId,
        traceId,
        correlationId,
      );
    } catch (err: unknown) {
      this.logger.error('Failed to get user bookings');
      throw err;
    }
  }

  @Get('users/bookings/summaries')
  async getBookingSummaries(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<BookingSummariesResponseDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.safeBookingReadService.getBookingSummaries(
        userId,
        traceId,
        correlationId,
      );
    } catch (err: unknown) {
      this.logger.error('Failed to get booking summaries');
      throw err;
    }
  }

  @Get('users/bookings/:bookingReference')
  async getBookingDetail(
    @Param('bookingReference') bookingReference: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<BookingDetailDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.safeBookingReadService.getBookingDetailByReference(
        userId,
        bookingReference,
        traceId,
        correlationId,
      );
    } catch (err: unknown) {
      this.logger.error('Failed to get booking detail');
      throw err;
    }
  }
}
