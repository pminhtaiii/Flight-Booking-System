import {
  Controller,
  UseGuards,
  Post,
  Body,
  Req,
  Res,
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
import { Request, Response } from 'express';

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
    @Res({ passthrough: true }) res: Response,
  ): Promise<FlightSearchResponseDto> {
    res.setHeader('Cache-Control', 'private, no-store');
    if (typeof res.removeHeader === 'function') {
      res.removeHeader('ETag');
    }
    if (res.app && typeof res.app.get === 'function') {
      const application = res.app;
      const getSetting = application.get.bind(application);
      Object.defineProperty(res, 'app', {
        configurable: true,
        value: new Proxy(application, {
          get(target, property, receiver) {
            if (property === 'get') {
              return (setting: string): unknown => setting === 'etag fn' ? undefined : getSetting(setting);
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      });
    }

    const safeHeaders = headers || {};
    const traceId = safeHeaders['x-trace-id'] || safeHeaders['x-correlation-id'];
    const correlationId = safeHeaders['x-correlation-id'];

    const searchResult = await this.flightsService.search(req.user.id, body, traceId, correlationId);

    return searchResult;
  }


  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<FlightDetailResponseDto> {
    return this.flightsService.getFlightDetail(id, req.user.id);
  }
}
