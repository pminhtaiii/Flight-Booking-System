import { BadRequestException, Body, Controller, Get, Headers, Param, ParseBoolPipe, ParseUUIDPipe, Put, Query, Req, UseGuards, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { AncillariesService } from './ancillaries.service';
import { CommitAncillarySelectionDto } from './dto/commit-ancillary-selection.dto';

interface AuthenticatedRequest extends Request { user: { id: string }; }
@Controller('bookings/intent/:intentId/ancillaries')
@UseGuards(JwtAuthGuard)
export class AncillariesController {
  constructor(private readonly service: AncillariesService) {}
  @Get()
  read(
    @Req() req: AuthenticatedRequest,
    @Param('intentId', new ParseUUIDPipe({ version: '4' })) intentId: string,
    @Query('refresh', new ParseBoolPipe({ optional: true })) refresh?: boolean,
  ) {
    if (process.env.FEATURE_FLAG_ANCILLARY_CATALOG === 'false') {
      throw new NotFoundException({ code: 'ANCILLARY_FEATURE_DISABLED', message: 'Ancillary catalog is disabled' });
    }
    const traceId = req.headers['x-trace-id'] as string | undefined;
    const correlationId = req.headers['x-correlation-id'] as string | undefined;
    return this.service.read(req.user.id, intentId, refresh, traceId, correlationId);
  }
  @Put()
  commit(
    @Req() req: AuthenticatedRequest,
    @Param('intentId', new ParseUUIDPipe({ version: '4' })) intentId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CommitAncillarySelectionDto,
  ) {
    if (process.env.FEATURE_FLAG_ANCILLARY_COMMIT === 'false') {
      throw new ForbiddenException({ code: 'ANCILLARY_COMMIT_DISABLED', message: 'Ancillary selection commit is disabled' });
    }
    if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const traceId = req.headers['x-trace-id'] as string | undefined;
    const correlationId = req.headers['x-correlation-id'] as string | undefined;
    return this.service.commit(req.user.id, intentId, key, dto, traceId, correlationId);
  }
}
