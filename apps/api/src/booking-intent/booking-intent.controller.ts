import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { BookingIntentService } from './booking-intent.service';
import { CreateIntentDto } from './dto/create-intent.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('bookings/intent')
@UseGuards(JwtAuthGuard)
export class BookingIntentController {
  constructor(private readonly bookingIntentService: BookingIntentService) {}

  @Post()
  async createIntent(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateIntentDto,
  ) {
    const rawIp = req.ip || req.socket?.remoteAddress || '127.0.0.1';
    const ipAddress = typeof rawIp === 'string' ? rawIp.split(',')[0].trim() : '127.0.0.1';

    return this.bookingIntentService.createIntent(req.user.id, dto, {
      ipAddress,
      traceId: headers['x-trace-id'] || undefined,
      correlationId: headers['x-correlation-id'] || undefined,
    });
  }

  @Get('prefill')
  async getPrefill(@Req() req: AuthenticatedRequest) {
    return this.bookingIntentService.getPrefill(req.user.id);
  }

  @Get(':id')
  async getIntent(@Req() req: AuthenticatedRequest, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.bookingIntentService.getIntent(req.user.id, id);
  }
}
