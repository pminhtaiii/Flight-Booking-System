import { Controller, Get, Req, Headers, UseGuards, Logger } from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from '../auth/agent-api-key.guard';
import { ClaimTokenGuard } from '../auth/claim-token.guard';
import { TravelerPreferencesService } from './traveler-preferences.service';
import { UserPreferencesDto } from '../dto/user-preferences.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class TravelerPreferencesController {
  private readonly logger = new Logger(TravelerPreferencesController.name);

  constructor(private readonly travelerPreferencesService: TravelerPreferencesService) {}

  @Get('users/preferences')
  async getUserPreferences(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<UserPreferencesDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.travelerPreferencesService.getUserPreferences(
        userId,
        traceId,
        correlationId,
      );
    } catch (err: unknown) {
      this.logger.error('Failed to get user preferences');
      throw err;
    }
  }
}
