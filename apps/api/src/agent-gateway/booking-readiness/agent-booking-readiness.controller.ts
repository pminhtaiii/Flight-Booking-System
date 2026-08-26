import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from '../auth/agent-api-key.guard';
import { ClaimTokenGuard } from '../auth/claim-token.guard';
import { AgentBookingReadinessService } from './agent-booking-readiness.service';
import {
  AgentBookingReadinessRequestDto,
  AgentBookingReadinessResponseDto,
} from '../dto/booking-readiness.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class AgentBookingReadinessController {
  private readonly logger = new Logger(AgentBookingReadinessController.name);

  constructor(private readonly readinessService: AgentBookingReadinessService) {}

  @Post('bookings/readiness')
  @HttpCode(200)
  async checkBookingReadiness(
    @Body() dto: AgentBookingReadinessRequestDto,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<AgentBookingReadinessResponseDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.readinessService.checkBookingReadiness(
        userId,
        dto,
        traceId,
        correlationId,
      );
    } catch (err: unknown) {
      this.logger.error('Failed to check booking readiness');
      throw err;
    }
  }
}
