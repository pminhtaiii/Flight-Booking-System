import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { AncillariesService } from './ancillaries.service';
import { CommitAncillarySelectionDto } from './dto/commit-ancillary-selection.dto';

interface AuthenticatedRequest extends Request {
  user: { id: string };
}
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
    return this.service.read(req.user.id, intentId, refresh);
  }
  @Put()
  commit(
    @Req() req: AuthenticatedRequest,
    @Param('intentId', new ParseUUIDPipe({ version: '4' })) intentId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CommitAncillarySelectionDto,
  ) {
    if (!key) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.service.commit(req.user.id, intentId, key, dto);
  }
}
