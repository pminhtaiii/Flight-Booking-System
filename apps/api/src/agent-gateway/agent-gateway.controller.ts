import { Controller, Get, Query, Req, UseGuards, Logger, Headers, Param, Body, Post, HttpCode, Delete } from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from './auth/agent-api-key.guard';
import { ClaimTokenGuard } from './auth/claim-token.guard';
import { AgentGatewayService } from './agent-gateway.service';
import { FlightSearchQueryDto } from './dto/flight-search-query.dto';
import { FlightSearchResponseDto } from './dto/flight-result.dto';
import { AttestedFlightSearchDto } from './dto/attested-flight-search.dto';
import { UserPreferencesDto } from './dto/user-preferences.dto';
import { UserBookingsResponseDto } from './dto/user-bookings.dto';
import {
  AgentBookingReadinessRequestDto,
  AgentBookingReadinessResponseDto,
} from './dto/booking-readiness.dto';

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

  @Post('v2/flights/search')
  @HttpCode(201)
  async searchFlightsV2(
    @Body() dto: AttestedFlightSearchDto,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ) {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.agentGatewayService.searchFlightsV2(userId, dto, traceId, correlationId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Failed to search attested flights: ${msg}`, stack);
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

      return await this.agentGatewayService.checkBookingReadiness(userId, dto, traceId, correlationId);
    } catch (err: unknown) {
      this.logger.error('Failed to check booking readiness');
      throw err;
    }
  }

  @Post('chat/access/check')
  @HttpCode(200)
  async checkAccess(
    @Body() dto: { sub: string; jti?: string; exp?: number },
  ) {
    return await this.agentGatewayService.checkUserAccess(dto);
  }

  @Post('chat/sessions')
  @HttpCode(201)
  async createSession(
    @Req() req: AuthenticatedRequest,
    @Body() dto: { title?: string },
  ) {
    return await this.agentGatewayService.createSession(req.user.id, dto.title);
  }

  @Get('chat/sessions/:sessionId/memory')
  async getMemory(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Query() query: { recentCount?: number; unsummarizedOnly?: boolean },
  ) {
    return await this.agentGatewayService.getMemory(req.user.id, sessionId, query);
  }

  @Post('chat/sessions/:sessionId/messages')
  @HttpCode(201)
  async createChatMessage(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { sender: string; content: string; type?: string },
  ) {
    const fencingToken = headers['x-fencing-token'] || headers['X-Fencing-Token'];
    return await this.agentGatewayService.createChatMessage(req.user.id, sessionId, dto, fencingToken);
  }

  @Post('chat/sessions/:sessionId/turns')
  @HttpCode(201)
  async createChatTurn(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { messages: Array<{ sender?: string; content?: string; type?: string }> },
  ) {
    const fencingToken = headers['x-fencing-token'] || headers['X-Fencing-Token'];
    return await this.agentGatewayService.createMessageBatch(
      req.user.id,
      sessionId,
      {
        messages: dto.messages.map(m => ({
          sender: m.sender || 'USER',
          content: m.content || '',
          type: m.type || 'STANDARD',
        })),
      },
      fencingToken,
    );
  }

  @Post('chat/sessions/:sessionId/summaries')
  @HttpCode(201)
  async createChatSummary(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
    @Body() dto: { content: string },
  ) {
    const fencingToken = headers['x-fencing-token'] || headers['X-Fencing-Token'];
    return await this.agentGatewayService.createChatMessage(
      req.user.id,
      sessionId,
      {
        sender: 'AGENT',
        content: dto.content,
        type: 'SUMMARY',
      },
      fencingToken,
    );
  }

  @Delete('chat/sessions/:sessionId')
  @HttpCode(204)
  async deleteSession(
    @Param('sessionId') sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.agentGatewayService.deleteSession(req.user.id, sessionId);
  }
}
