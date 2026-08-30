import {
  Controller,
  UseGuards,
  Post,
  Body,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
  Get,
  Param,
} from '@nestjs/common';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { FlightsService } from './flights.service';
import { FlightSearchRequestDto, FlightSearchResponseDto } from './dto/search-flight.dto';
import { FlightDetailResponseDto } from './dto/detail-flight.dto';
import { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
  };
}

@Controller(['api/flights', 'flights'])
@UseGuards(JwtAuthGuard)
export class FlightsController {
  constructor(private readonly flightsService: FlightsService) {}

  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(
    @Body() body: FlightSearchRequestDto,
    @Req() req: AuthenticatedRequest,
    @Headers() headers: Record<string, string>,
  ): Promise<FlightSearchResponseDto> {
    const traceId = headers['x-trace-id'] || headers['x-correlation-id'];
    const correlationId = headers['x-correlation-id'];

    return this.flightsService.search(req.user.id, body, traceId, correlationId);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<FlightDetailResponseDto> {
    return this.flightsService.getFlightDetail(id, req.user.id);
  }
}
