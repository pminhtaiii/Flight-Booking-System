import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { BookingManagementService } from './booking-management.service';
import {
  BookingDetailResponseDto,
  BookingListQueryDto,
  BookingListResponseDto,
} from './dto';

type AuthenticatedRequest = Request & {
  user: { id: string };
};

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingManagementController {
  constructor(
    private readonly bookingManagementService: BookingManagementService,
  ) {}

  @Get()
  async listBookings(
    @Req() req: AuthenticatedRequest,
    @Query() query: BookingListQueryDto,
  ): Promise<BookingListResponseDto> {
    return this.bookingManagementService.listBookings(
      req.user.id,
      query.tab,
      query.page,
      query.limit,
    );
  }

  @Get(':bookingId')
  async getBookingDetail(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
  ): Promise<BookingDetailResponseDto> {
    return this.bookingManagementService.getBookingDetail(bookingId, req.user.id);
  }
}
