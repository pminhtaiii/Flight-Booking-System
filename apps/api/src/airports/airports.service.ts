import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';

@Injectable()
export class AirportsService {
  private readonly logger = new Logger(AirportsService.name);
  private readonly countryCache = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async search(q: string, limit: number) {
    try {
      return await this.prisma.airport.findMany({
        where: {
          OR: [
            { iataCode: { equals: q, mode: 'insensitive' } },
            { name: { contains: q, mode: 'insensitive' } },
            { city: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          iataCode: true,
          name: true,
          city: true,
          country: true,
          latitude: true,
          longitude: true,
          type: true,
        },
        take: limit,
      });
    } catch (error) {
      this.logger.error(`[search] Failed to search airports for query: ${q}`, error);
      throw error;
    }
  }

  async findByIataCode(iataCode: string) {
    try {
      const airport = await this.prisma.airport.findUnique({
        where: { iataCode: iataCode.trim().toUpperCase() },
      });
      if (!airport) {
        throw new NotFoundException(`Airport with IATA code '${iataCode}' not found`);
      }
      return airport;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`[findByIataCode] Failed to find airport by IATA: ${iataCode}`, error);
      throw error;
    }
  }

  async findCountriesByIataCodes(codes: readonly string[]): Promise<Map<string, string | null>> {
    const normalizedCodes = [...new Set(
      codes
        .map((code) => code.trim().toUpperCase())
        .filter((code) => /^[A-Z]{3}$/.test(code)),
    )];

    const missingCodes: string[] = [];
    const countries = new Map<string, string | null>();

    for (const code of normalizedCodes) {
      if (this.countryCache.has(code)) {
        countries.set(code, this.countryCache.get(code)!);
      } else {
        missingCodes.push(code);
      }
    }

    if (missingCodes.length > 0) {
      const rows = await this.prisma.airport.findMany({
        where: { iataCode: { in: missingCodes } },
        select: { iataCode: true, country: true },
      });

      for (const code of missingCodes) {
        this.countryCache.set(code, null);
      }
      for (const row of rows) {
        const code = row.iataCode.trim().toUpperCase();
        const country = row.country ?? null;
        this.countryCache.set(code, country);
      }
      for (const code of missingCodes) {
        countries.set(code, this.countryCache.get(code)!);
      }
    }

    return countries;
  }

  async findNearby(lat: number, lng: number, radiusKm: number, limit: number) {
    try {
      // Clamped Haversine formula
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await this.prisma.$queryRaw<any[]>`
        SELECT *, 
               (6371 * acos(LEAST(GREATEST(cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lng})) + sin(radians(${lat})) * sin(radians(latitude)), -1.0), 1.0))) AS "distanceKm"
        FROM airports
        WHERE (6371 * acos(LEAST(GREATEST(cos(radians(${lat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${lng})) + sin(radians(${lat})) * sin(radians(latitude)), -1.0), 1.0))) <= ${radiusKm}
        ORDER BY "distanceKm" ASC
        LIMIT ${limit}
      `;

      return results.map(r => ({
        iataCode: r.iataCode,
        name: r.name,
        city: r.city,
        country: r.country,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        type: r.type,
        distanceKm: Number(r.distanceKm),
      }));
    } catch (error) {
      this.logger.error(`[findNearby] Failed to find nearby airports for lat=${lat}, lng=${lng}`, error);
      throw error;
    }
  }

  async findAll() {
    try {
      return await this.prisma.airport.findMany({
        select: {
          iataCode: true,
          name: true,
          city: true,
          country: true,
          latitude: true,
          longitude: true,
          type: true,
        },
      });
    } catch (error) {
      this.logger.error('[findAll] Failed to retrieve all airports', error);
      throw error;
    }
  }
}
