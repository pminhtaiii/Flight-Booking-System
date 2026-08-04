import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { BookingIntentService } from './booking-intent.service';
import { CreateIntentDto } from './dto/create-intent.dto';
import { BookingReadinessRequestDto } from './dto/booking-readiness.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

function requestContext(headers: Record<string, string>) {
  return {
    traceId: headers['x-trace-id'] || undefined,
    correlationId: headers['x-correlation-id'] || undefined,
  };
}

function setSafeHeaders(response: Response, headers: Record<string, string>): void {
  response.setHeader('Cache-Control', 'no-store, private');
  response.removeHeader('ETag');
  if (headers['x-trace-id']) response.setHeader('x-trace-id', headers['x-trace-id']);
  if (headers['x-correlation-id']) response.setHeader('x-correlation-id', headers['x-correlation-id']);
}

function assertCanonicalCreate(dto: CreateIntentDto): void {
  if (dto.passengers.some((passenger) => passenger.useProfile !== undefined)) {
    throw new HttpException(
      {
        code: 'PASSENGER_SOURCE_CONFLICT',
        message: 'Canonical passenger sources cannot use legacy profile selection',
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  if (dto.passengers.some((passenger) => passenger.source == null)) {
    throw new HttpException(
      {
        code: 'PASSENGER_SOURCE_INVALID',
        message: 'Canonical passenger sources are required',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

@Controller('bookings/intents')
@UseGuards(JwtAuthGuard)
export class BookingIntentController {
  private readonly logger = new Logger(BookingIntentController.name);

  constructor(private readonly bookingIntentService: BookingIntentService) {}

  /**
   * Compatibility surface for service-level tests and callers that imported the
   * pre-migration controller class. These methods are intentionally undecorated;
   * HTTP traffic uses the explicit plural or legacy controller routes above.
   */
  createIntent(
    userId: string,
    dto: CreateIntentDto,
    context?: Parameters<BookingIntentService['createIntent']>[2],
  ) {
    return this.bookingIntentService.createIntent(userId, dto, context);
  }

  getPrefill(userId: string) {
    return this.bookingIntentService.getPrefill(userId);
  }

  getIntent(userId: string, id: string) {
    return this.bookingIntentService.getIntent(userId, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createCanonicalIntent(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateIntentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertCanonicalCreate(dto);
    setSafeHeaders(response, headers);
    return this.bookingIntentService.createIntent(req.user.id, dto, {
      ...requestContext(headers),
      allowLegacy: false,
      ipAddress: req.ip || req.socket?.remoteAddress || undefined,
    });
  }

  @Get(':id')
  async getCanonicalIntent(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    setSafeHeaders(response, headers);
    return this.bookingIntentService.getIntent(req.user.id, id);
  }

  /** Readiness remains a separate controller action on this canonical route family. */
  @Post('readiness')
  @HttpCode(HttpStatus.OK)
  async createReadiness(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: BookingReadinessRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    setSafeHeaders(response, headers);
    return this.bookingIntentService.getAdvisoryReadiness(req.user.id, dto, requestContext(headers));
  }
}

@Controller('bookings/intent')
@UseGuards(JwtAuthGuard)
export class BookingIntentLegacyController {
  private readonly logger = new Logger(BookingIntentLegacyController.name);

  constructor(private readonly bookingIntentService: BookingIntentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createLegacyIntent(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateIntentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    setSafeHeaders(response, headers);
    this.logger.warn(JSON.stringify({
      operation: 'booking_intent_create_deprecated_route',
      status: 'deprecated',
      trace_id: headers['x-trace-id'] || null,
      correlation_id: headers['x-correlation-id'] || null,
    }));

    return this.bookingIntentService.createIntent(req.user.id, dto, {
      ...requestContext(headers),
      allowLegacy: true,
      ipAddress: req.ip || req.socket?.remoteAddress || undefined,
    });
  }

  @Get('prefill')
  async getPrefill(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Res({ passthrough: true }) response: Response,
  ) {
    setSafeHeaders(response, headers);
    this.logger.warn(JSON.stringify({
      operation: 'booking_intent_prefill_deprecated_route',
      status: 'deprecated',
      trace_id: headers['x-trace-id'] || null,
      correlation_id: headers['x-correlation-id'] || null,
    }));
    return this.bookingIntentService.getPrefill(req.user.id);
  }

  @Get(':id')
  async getLegacyIntent(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    setSafeHeaders(response, headers);
    this.logger.warn(JSON.stringify({
      operation: 'booking_intent_get_deprecated_route',
      status: 'deprecated',
      trace_id: headers['x-trace-id'] || null,
      correlation_id: headers['x-correlation-id'] || null,
    }));
    return this.bookingIntentService.getIntent(req.user.id, id);
  }
}

// Backward-compatible export name retained for existing readiness controller tests/imports.
export { BookingIntentController as BookingReadinessController };
