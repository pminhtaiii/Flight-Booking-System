import { Controller, Get, Param, Query, Logger, NotFoundException } from '@nestjs/common';
import { AirportsService } from './airports.service';
import { CacheService } from '@/cache/cache.service';
import { SearchAirportsDto } from './dto/search-airports.dto';
import { NearbyAirportsDto } from './dto/nearby-airports.dto';
import { CACHE_KEYS, CACHE_TTLS } from './airports.constants';

@Controller('airports')
export class AirportsController {
  private readonly logger = new Logger(AirportsController.name);

  constructor(
    private readonly airportsService: AirportsService,
    private readonly cache: CacheService,
  ) {}

  @Get('search')
  async search(@Query() dto: SearchAirportsDto) {
    try {
      const cacheKey = CACHE_KEYS.SEARCH(dto.q, dto.limit);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.log(`[search] Cache hit for key: ${cacheKey}`);
        return JSON.parse(cached);
      }

      const data = await this.airportsService.search(dto.q, dto.limit);
      const result = { data, count: data.length };
      
      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTLS.SEARCH);
      return result;
    } catch (error) {
      this.logger.error('[search] Error occurred during search endpoint execution', error);
      throw error;
    }
  }

  @Get('nearby')
  async findNearby(@Query() dto: NearbyAirportsDto) {
    try {
      const cacheKey = CACHE_KEYS.NEARBY(dto.lat, dto.lng, dto.radius, dto.limit);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.log(`[findNearby] Cache hit for key: ${cacheKey}`);
        return JSON.parse(cached);
      }

      const data = await this.airportsService.findNearby(dto.lat, dto.lng, dto.radius, dto.limit);
      const result = {
        data,
        count: data.length,
        center: { lat: dto.lat, lng: dto.lng },
        radiusKm: dto.radius,
      };

      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTLS.NEARBY);
      return result;
    } catch (error) {
      this.logger.error('[findNearby] Error occurred during nearby endpoint execution', error);
      throw error;
    }
  }

  @Get('all')
  async findAll() {
    try {
      const cacheKey = CACHE_KEYS.ALL;
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.log(`[findAll] Cache hit for key: ${cacheKey}`);
        return JSON.parse(cached);
      }

      const data = await this.airportsService.findAll();
      const result = { data, count: data.length };

      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTLS.ALL);
      return result;
    } catch (error) {
      this.logger.error('[findAll] Error occurred during all endpoint execution', error);
      throw error;
    }
  }

  @Get(':iataCode')
  async findByIataCode(@Param('iataCode') iataCode: string) {
    try {
      const cacheKey = CACHE_KEYS.DETAIL(iataCode);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.logger.log(`[findByIataCode] Cache hit for key: ${cacheKey}`);
        return JSON.parse(cached);
      }

      const result = await this.airportsService.findByIataCode(iataCode);
      await this.cache.set(cacheKey, JSON.stringify(result), CACHE_TTLS.DETAIL);
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`[findByIataCode] Error occurred during finding IATA: ${iataCode}`, error);
      throw error;
    }
  }
}
