import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Req,
  Headers,
  UseGuards,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { Request } from 'express';
import { AgentApiKeyGuard } from '../auth/agent-api-key.guard';
import { ClaimTokenGuard } from '../auth/claim-token.guard';
import { AttestedFlightSearchService } from './attested-flight-search.service';
import { FlightSearchQueryDto } from '../dto/flight-search-query.dto';
import { FlightSearchResponseDto } from '../dto/flight-result.dto';
import {
  AttestedFlightSearchDto,
  AttestedFlightSearchResponseDto,
} from '../dto/attested-flight-search.dto';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller('agent-gateway')
@UseGuards(AgentApiKeyGuard, ClaimTokenGuard)
export class AttestedFlightSearchController {
  private readonly logger = new Logger(AttestedFlightSearchController.name);

  constructor(private readonly flightSearchService: AttestedFlightSearchService) {}

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

      return await this.flightSearchService.searchFlights(userId, query, traceId, correlationId);
    } catch (err: unknown) {
      this.logger.error('Failed to search flights');
      throw err;
    }
  }

  @Post('v2/flights/search')
  @HttpCode(201)
  async searchFlightsV2(
    @Body() dto: AttestedFlightSearchDto,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<AttestedFlightSearchResponseDto> {
    try {
      const traceId = headers['x-trace-id'] || null;
      const correlationId = headers['x-correlation-id'] || null;
      const userId = req.user.id;

      return await this.flightSearchService.searchFlightsV2(userId, dto, traceId, correlationId);
    } catch (err: unknown) {
      this.logger.error('Failed to search attested flights');
      throw err;
    }
  }
}
