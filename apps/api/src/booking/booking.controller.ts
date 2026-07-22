import { Controller, Get, Post, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { BookingService } from './booking.service';
import { BookingDetailResponseDto, BookingListQueryDto, BookingListResponseDto } from './dto';
import { CancellationQuoteResponseDto } from '@shared/booking-types';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  async listBookings(@Req() req: AuthenticatedRequest, @Query() query: BookingListQueryDto): Promise<BookingListResponseDto> {
    return this.bookingService.listBookings(req.user.id, query.tab, query.page, query.limit);
  }

  @Get(':bookingId')
  async getBookingDetail(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
  ): Promise<BookingDetailResponseDto> {
    return this.bookingService.getBookingDetail(bookingId, req.user.id);
  }

  @Post(':bookingId/cancellation-quote')
  @UseGuards(JwtAuthGuard)
  async getCancellationQuote(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
  ): Promise<CancellationQuoteResponseDto> {
    return this.bookingService.getCancellationQuote(bookingId, req.user.id);
  }
}
