import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelService } from '@/duffel/duffel.service';
import { AuditService } from '@/audit/audit.service';
import { FlightSearchRequestDto, FlightSearchResponseDto, FlightOfferDto, FlightSegmentDto } from './dto/search-flight.dto';
import { DuffelOffer, DuffelSegment } from '@/duffel/duffel.types';
import { Prisma } from '@prisma/client';
import * as crypto from 'crypto';

function parseISO8601Duration(durationStr: string): number {
  const regex = /P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/;
  const matches = durationStr.match(regex);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 1440 + hours * 60 + minutes;
}

function generateDeterministicUUID(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32)
  ].join('-');
}

function capitalize(str: string | null | undefined): string | null {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function mapSegment(segment: DuffelSegment): FlightSegmentDto {
  const aircraftName = segment.aircraft?.name || '';
  const aircraftCode = segment.aircraft?.iata_code || '';
  const aircraft = aircraftName.includes('Airbus')
    ? aircraftName.replace('Airbus ', '')
    : aircraftName || aircraftCode || null;

  return {
    carrierCode: segment.marketing_carrier?.iata_code || '',
    flightNumber: segment.marketing_carrier_flight_number || '',
    operatingCarrier: segment.operating_carrier?.name || '',
    departureAirport: segment.origin?.iata_code || '',
    departureTerminal: segment.origin_terminal || null,
    departureTime: segment.departing_at,
    arrivalAirport: segment.destination?.iata_code || '',
    arrivalTerminal: segment.destination_terminal || null,
    arrivalTime: segment.arriving_at,
    duration: parseISO8601Duration(segment.duration),
    aircraft,
  };
}

function mapOffer(offer: DuffelOffer, id: string): FlightOfferDto {
  const outboundSlice = offer.slices[0];
  const firstSegment = outboundSlice?.segments[0];
  const lastSegment = outboundSlice?.segments[outboundSlice.segments.length - 1];

  const airline = firstSegment?.operating_carrier?.name || firstSegment?.marketing_carrier?.name || 'Unknown Airline';
  const flightNumber = (firstSegment?.marketing_carrier?.iata_code || '') + (firstSegment?.marketing_carrier_flight_number || '');

  const segmentBaggage = firstSegment?.passengers?.[0]?.baggages;
  let baggageAllowance: string | null = null;
  if (segmentBaggage && segmentBaggage.length > 0) {
    const bag = segmentBaggage[0];
    baggageAllowance = `${bag.quantity || 0} ${bag.type} bag(s)`;
  }

  const cabinClass = firstSegment?.passengers?.[0]?.cabin_class || null;

  const returnSlice = offer.slices[1];

  return {
    id,
    duffelOfferId: offer.id,
    airline,
    flightNumber,
    departureAirport: firstSegment?.origin?.iata_code || '',
    arrivalAirport: lastSegment?.destination?.iata_code || '',
    departureTime: firstSegment?.departing_at || '',
    arrivalTime: lastSegment?.arriving_at || '',
    duration: parseISO8601Duration(outboundSlice?.duration || 'PT0H0M'),
    stops: outboundSlice ? outboundSlice.segments.length - 1 : 0,
    price: parseFloat(offer.total_amount),
    currency: offer.total_currency,
    fareClass: capitalize(cabinClass),
    baggageAllowance,
    segments: outboundSlice?.segments.map(mapSegment) || [],
    returnSegments: returnSlice ? returnSlice.segments.map(mapSegment) : null,
  };
}

@Injectable()
export class FlightsService {
  private readonly logger = new Logger(FlightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    private readonly duffelService: DuffelService,
    private readonly auditService: AuditService,
  ) {}

  async search(
    userId: string,
    query: FlightSearchRequestDto,
    traceId?: string,
    correlationId?: string,
  ): Promise<FlightSearchResponseDto> {
    const origin = query.origin.trim().toUpperCase();
    const destination = query.destination.trim().toUpperCase();
    
    if (origin === destination) {
      throw new BadRequestException('Origin and destination must be different');
    }

    if (query.returnDate) {
      const depDate = new Date(query.departureDate);
      const retDate = new Date(query.returnDate);
      if (retDate < depDate) {
        throw new BadRequestException('Return date must be on or after departure date');
      }
    }

    // Validate that origin and destination airports exist in the Airport table
    const [originAirport, destAirport] = await Promise.all([
      this.prisma.airport.findUnique({ where: { iataCode: origin } }),
      this.prisma.airport.findUnique({ where: { iataCode: destination } }),
    ]);

    if (!originAirport) {
      throw new BadRequestException(`Origin airport with code ${origin} does not exist`);
    }
    if (!destAirport) {
      throw new BadRequestException(`Destination airport with code ${destination} does not exist`);
    }

    const forSearch = {
      origin,
      destination,
      departureDate: query.departureDate,
      returnDate: query.returnDate || undefined,
      passengers: Number(query.passengers),
    };

    const searchResult = await this.duffelService.searchFlights(forSearch, 'user');
    const rawResult = searchResult.offerRequest;
    const cached = searchResult.cached;
    const sha256 = searchResult.searchHash;

    // Map raw offers to FlightOfferDto capping at 20 results using deterministic UUIDs
    const results: FlightOfferDto[] = (rawResult.offers || [])
      .slice(0, 20)
      .map((offer) => {
        const id = generateDeterministicUUID(`${sha256}:${offer.id}`);
        return mapOffer(offer, id);
      });

    // Write async write-behind persistence only on cache miss (non-cached searches)
    if (!cached) {
      setImmediate(async () => {
        try {
          const prices = results.map(r => r.price);
          const minPrice = prices.length > 0 ? Math.min(...prices) : null;
          const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
          const currency = results.length > 0 ? results[0].currency : 'USD';

          await this.prisma.$transaction(async (tx) => {
            await tx.searchHistory.create({
              data: {
                userId,
                origin,
                destination,
                departureDate: new Date(query.departureDate),
                returnDate: query.returnDate ? new Date(query.returnDate) : null,
                passengers: Number(query.passengers),
                resultCount: results.length,
                minPrice,
                maxPrice,
                currency,
                searchHash: sha256,
              },
            });

            const flightOffersData = results.map((offerDto) => {
              const rawOffer = rawResult.offers.find(o => o.id === offerDto.duffelOfferId);
              return {
                id: offerDto.id,
                searchHash: sha256,
                duffelOfferId: offerDto.duffelOfferId,
                rawOffer: rawOffer ? (rawOffer as unknown as Prisma.InputJsonValue) : {},
                origin,
                destination,
                departureDate: new Date(query.departureDate),
                returnDate: query.returnDate ? new Date(query.returnDate) : null,
                passengers: Number(query.passengers),
                price: new Prisma.Decimal(offerDto.price),
                currency: offerDto.currency,
              };
            });

            const offerRecoveriesData = results.map((offerDto) => ({
              id: offerDto.id,
              searchHash: sha256,
            }));

            if (flightOffersData.length > 0) {
              await tx.flightOffer.createMany({
                data: flightOffersData,
              });
              await tx.offerRecovery.createMany({
                data: offerRecoveriesData,
              });
            }
          });
        } catch (error) {
          this.logger.error('Failed to save search history and offers atomically', error);
        }
      });
    }

    // Create audit log entry (synchronous so test can immediately assert it)
    await this.auditService.createLog(this.prisma, {
      userId,
      action: 'flight_search',
      resourceType: 'Flight',
      metadata: {
        origin,
        destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate || null,
        passengers: Number(query.passengers),
        searchHash: sha256,
      },
      traceId,
      correlationId,
    });

    return {
      results,
      meta: {
        totalResults: results.length,
        searchHash: sha256,
        cached,
      },
    };
  }
}
