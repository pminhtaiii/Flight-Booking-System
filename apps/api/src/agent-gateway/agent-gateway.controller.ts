import { Controller, Get, Query, Req, UseGuards, Logger, Headers } from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from './auth/agent-api-key.guard';
import { ClaimTokenGuard } from './auth/claim-token.guard';
import { AgentGatewayService } from './agent-gateway.service';
import { FlightSearchQueryDto } from './dto/flight-search-query.dto';
import { FlightSearchResponseDto } from './dto/flight-result.dto';
import { UserPreferencesDto } from './dto/user-preferences.dto';
import { UserBookingsResponseDto } from './dto/user-bookings.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class AgentGatewayController {
  private readonly logger = new Logger(AgentGatewayController.name);

  constructor(private readonly agentGatewayService: AgentGatewayService) {}

  @Get('flights/search')
  async searchFlights(
    @Query() query: FlightSearchQueryDto,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<FlightSearchResponseDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.agentGatewayService.searchFlights(userId, query, traceId, correlationId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Failed to search flights: ${msg}`, stack);
      throw err;
    }
  }

  @Get('users/preferences')
  async getUserPreferences(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<UserPreferencesDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.agentGatewayService.getUserPreferences(userId, traceId, correlationId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Failed to get user preferences: ${msg}`, stack);
      throw err;
    }
  }

  @Get('users/bookings')
  async getUserBookings(
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<UserBookingsResponseDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.agentGatewayService.getUserBookings(userId, traceId, correlationId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Failed to get user bookings: ${msg}`, stack);
      throw err;
    }
  }
}
