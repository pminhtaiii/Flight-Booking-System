import {
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassengerType } from '@prisma/client';
import { AirportsService } from '@/airports/airports.service';
import { ProfileService } from '@/profile/profile.service';
import { PrismaService } from '@/prisma/prisma.service';
import {
  BookingReadinessInlineSourceDto,
  BookingReadinessPassengerDto,
  BookingReadinessRequestDto,
  BookingReadinessResponseDto,
  BookingReadinessTravelerProfileSourceDto,
} from './dto/booking-readiness.dto';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { BookingReadinessObservability } from './booking-readiness.observability';
import { BookingReadinessOperation } from '../common/observability/booking-readiness-observability.types';
import { parseBookingReadinessConfig } from './booking-readiness.config';
import { BookingReadinessEvaluator } from './booking-readiness.evaluator';
import type {
  BookingReadinessEvaluationInput,
  BookingReadinessPassengerInput,
  BookingReadinessSegmentInput,
} from './booking-readiness.types';
import type { ResolvedPassenger } from './passenger-source-resolver.service';

type ReadinessContext = {
  traceId?: string;
  correlationId?: string;
};

type RawRecord = Record<string, unknown>;

type StoredOfferPassenger = {
  id: string;
  type: PassengerType;
};

type NormalizedOffer = {
  passengers: StoredOfferPassenger[];
  segments: BookingReadinessSegmentInput[];
  airportCodes: string[];
  tripCompletionDate: string;
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function dateOnlyFromRaw(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const dateOnly = value.slice(0, 10);
  return isValidDateOnly(dateOnly) ? dateOnly : null;
}

function iataFromRaw(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function httpError(
  code: string,
  message: string,
  status: HttpStatus,
): HttpException {
  return new HttpException({ code, message }, status);
}

function passengerTypeFromRaw(value: unknown): PassengerType | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'adult') {
    return PassengerType.ADULT;
  }
  if (normalized === 'child') {
    return PassengerType.CHILD;
  }
  if (normalized === 'infant') {
    return PassengerType.INFANT;
  }

  return null;
}

function currentDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function profilePassenger(
  source: BookingReadinessTravelerProfileSourceDto,
  profile: RawRecord,
  passenger: BookingReadinessPassengerDto,
  passengerOrdinal: number,
): BookingReadinessPassengerInput {
  const identity = isRecord(profile.identity) ? profile.identity : null;
  const contact = isRecord(profile.contact) ? profile.contact : null;
  const travelDocument = isRecord(profile.travelDocument) ? profile.travelDocument : null;
  const revision = typeof profile.revision === 'number' && Number.isInteger(profile.revision)
    ? profile.revision
    : null;

  return {
    passengerType: passenger.passengerType,
    passengerOrdinal,
    profileRevision: revision,
    givenName: typeof identity?.givenName === 'string' ? identity.givenName : null,
    middleName: typeof identity?.middleName === 'string' ? identity.middleName : null,
    familyName: typeof identity?.familyName === 'string' ? identity.familyName : null,
    dateOfBirth: typeof identity?.dateOfBirth === 'string' ? identity.dateOfBirth : null,
    gender: typeof identity?.gender === 'string' ? identity.gender : null,
    title: typeof identity?.title === 'string' ? identity.title : null,
    email: typeof contact?.email === 'string' ? contact.email : null,
    phoneCountryCode: typeof contact?.phoneCountryCode === 'string' ? contact.phoneCountryCode : null,
    phoneNumber: typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : null,
    documentType: typeof travelDocument?.documentType === 'string' ? travelDocument.documentType : null,
    passportNumber: typeof travelDocument?.passportNumber === 'string' ? travelDocument.passportNumber : null,
    passportExpiry: typeof travelDocument?.passportExpiry === 'string' ? travelDocument.passportExpiry : null,
    issuingCountry: typeof travelDocument?.issuingCountry === 'string' ? travelDocument.issuingCountry : null,
    nationality: typeof travelDocument?.nationality === 'string' ? travelDocument.nationality : null,
  };
}

function inlinePassenger(
  source: BookingReadinessInlineSourceDto,
  passenger: BookingReadinessPassengerDto,
  passengerOrdinal: number,
): BookingReadinessPassengerInput {
  return {
    passengerType: passenger.passengerType,
    passengerOrdinal,
    profileRevision: null,
    givenName: source.givenName,
    middleName: source.middleName,
    familyName: source.familyName,
    dateOfBirth: source.dateOfBirth,
    gender: source.gender,
    title: source.title,
    email: source.email,
    phoneCountryCode: source.phoneCountryCode,
    phoneNumber: source.phoneNumber,
    documentType: source.documentType,
    passportNumber: source.passportNumber,
    passportExpiry: source.passportExpiry,
    issuingCountry: source.issuingCountry,
    nationality: source.nationality,
  };
}

@Injectable()
export class BookingReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profileService: ProfileService,
    private readonly airportsService: AirportsService,
    private readonly bookingReadinessEvaluator: BookingReadinessEvaluator,
    private readonly bookingReadinessObservability: BookingReadinessObservability,
    private readonly configService: ConfigService,
    private readonly chatHandoffService: ChatHandoffService,
  ) {}

  async getAdvisoryReadiness(
    userId: string,
    dto: BookingReadinessRequestDto,
    context?: ReadinessContext,
  ): Promise<BookingReadinessResponseDto> {
    const startedAt = Date.now();

    try {
      this.assertFeatureEnabled();

      let flightOfferId = dto.flightOfferId;
      if (dto.handoffToken) {
        const handoff = await this.chatHandoffService.resolve(dto.handoffToken, userId);
        flightOfferId = handoff.flightOfferId;
      }

      const flightOffer = await this.prisma.flightOffer.findUnique({
        where: { id: flightOfferId },
      });

      if (!flightOffer) {
        throw httpError('OFFER_NOT_FOUND', 'Flight offer not found', HttpStatus.NOT_FOUND);
      }

      this.assertOfferNotExpired(flightOffer.rawOffer);
      const normalizedOffer = this.normalizeStoredOffer(flightOffer.rawOffer);
      this.validatePassengerMappings(dto.passengers, normalizedOffer.passengers);

      const passengers = await this.resolvePassengers(dto.passengers, normalizedOffer.passengers, userId);
      const countries = await this.airportsService.findCountriesByIataCodes(normalizedOffer.airportCodes);
      if (!(countries instanceof Map)) {
        throw new Error('Airport country lookup returned an invalid result');
      }

      const configValue = this.configService.get<string>('PASSPORT_ADVISORY_BUFFER_DAYS');
      const readinessConfig = parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: configValue });
      const evaluationInput: BookingReadinessEvaluationInput = {
        passengers,
        segments: normalizedOffer.segments.map((segment) => ({
          ...segment,
          originCountryCode: segment.originCountryCode
            ? countries.get(segment.originCountryCode) ?? null
            : null,
          destinationCountryCode: segment.destinationCountryCode
            ? countries.get(segment.destinationCountryCode) ?? null
            : null,
        })),
        tripCompletionDate: normalizedOffer.tripCompletionDate,
        supportedDocumentTypes: ['passport'],
        advisoryBufferDays: readinessConfig.passportAdvisoryBufferDays,
        currentDate: currentDateOnly(),
        entryEligibility: {
          include: true,
          result: {
            status: 'unknown',
            reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
            blocking: false,
          },
        },
      };

      const result = this.bookingReadinessEvaluator.evaluate(evaluationInput);
      this.recordOutcome(
        {
          status: result.ready ? 'ready' : 'not_ready',
          metadata: {
            scope: result.scope,
            passengerCount: result.passengers.length,
          },
        },
        context,
        startedAt,
      );

      return result;
    } catch (error) {
      const mappedError = this.mapError(error);
      this.recordOutcome(
        {
          status: this.errorCode(mappedError),
          error: mappedError.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR,
          metadata: { reasonCode: this.errorCode(mappedError) },
        },
        context,
        startedAt,
      );
      throw mappedError;
    }
  }

  /**
   * Runs the same deterministic evaluator used by the advisory endpoint after
   * the authoritative create flow has resolved every passenger source. This
   * method performs no persistence and intentionally accepts only server-owned
   * offer data plus detached passenger values.
   */
  async evaluateAuthoritativeReadiness(
    rawOffer: unknown,
    passengers: readonly ResolvedPassenger[],
    context?: ReadinessContext,
  ): Promise<BookingReadinessResponseDto> {
    const startedAt = Date.now();

    try {
      this.assertFeatureEnabled();
      const normalizedOffer = this.normalizeStoredOffer(rawOffer);
      const storedById = new Map(normalizedOffer.passengers.map((passenger) => [passenger.id, passenger]));

      const evaluationPassengers: BookingReadinessPassengerInput[] = passengers.map((passenger) => {
        const storedPassenger = storedById.get(passenger.offerPassengerId);
        if (!storedPassenger || storedPassenger.type !== passenger.type) {
          throw httpError('PASSENGER_MAPPING_INVALID', 'Passenger mapping is invalid', HttpStatus.UNPROCESSABLE_ENTITY);
        }

        return {
          passengerType: passenger.type,
          passengerOrdinal: normalizedOffer.passengers.findIndex((item) => item.id === passenger.offerPassengerId) + 1,
          profileRevision: passenger.profileRevision,
          givenName: passenger.givenName,
          middleName: passenger.middleName,
          familyName: passenger.familyName,
          dateOfBirth: passenger.dateOfBirth,
          gender: passenger.gender,
          title: passenger.title,
          email: passenger.email,
          phoneCountryCode: passenger.phoneCountryCode,
          phoneNumber: passenger.phoneNumber,
          documentType: passenger.documentType,
          passportNumber: passenger.passportNumber,
          passportExpiry: passenger.passportExpiry,
          issuingCountry: passenger.issuingCountry,
          nationality: passenger.nationality,
        };
      });

      const countries = await this.airportsService.findCountriesByIataCodes(normalizedOffer.airportCodes);
      if (!(countries instanceof Map)) {
        throw new Error('Airport country lookup returned an invalid result');
      }

      const configValue = this.configService.get<string>('PASSPORT_ADVISORY_BUFFER_DAYS');
      const readinessConfig = parseBookingReadinessConfig({ PASSPORT_ADVISORY_BUFFER_DAYS: configValue });
      const result = this.bookingReadinessEvaluator.evaluate({
        passengers: evaluationPassengers,
        segments: normalizedOffer.segments.map((segment) => ({
          ...segment,
          originCountryCode: segment.originCountryCode
            ? countries.get(segment.originCountryCode) ?? null
            : null,
          destinationCountryCode: segment.destinationCountryCode
            ? countries.get(segment.destinationCountryCode) ?? null
            : null,
        })),
        tripCompletionDate: normalizedOffer.tripCompletionDate,
        supportedDocumentTypes: ['passport'],
        advisoryBufferDays: readinessConfig.passportAdvisoryBufferDays,
        currentDate: currentDateOnly(),
        entryEligibility: {
          include: true,
          result: {
            status: 'unknown',
            reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
            blocking: false,
          },
        },
      });

      this.recordOutcome(
        {
          status: result.ready ? 'ready' : 'not_ready',
          operation: BookingReadinessOperation.INTENT_AUTHORITATIVE_VALIDATION,
          metadata: {
            scope: result.scope,
            passengerCount: result.passengers.length,
          },
        },
        context,
        startedAt,
      );

      return result;
    } catch (error) {
      const mappedError = this.mapError(error);
      this.recordOutcome(
        {
          status: this.errorCode(mappedError),
          operation: BookingReadinessOperation.INTENT_AUTHORITATIVE_VALIDATION,
          error: mappedError.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR,
          metadata: { reasonCode: this.errorCode(mappedError) },
        },
        context,
        startedAt,
      );
      throw mappedError;
    }
  }

  private assertFeatureEnabled(): void {
    if (this.configService.get<string>('FEATURE_FLAG_BOOKING_READINESS') !== 'true') {
      throw new NotFoundException({
        code: 'FEATURE_DISABLED',
        message: 'Booking readiness is unavailable',
      });
    }
  }

  private normalizeStoredOffer(rawOffer: unknown): NormalizedOffer {
    if (!isRecord(rawOffer) || !Array.isArray(rawOffer.passengers) || !Array.isArray(rawOffer.slices)) {
      throw new Error('Stored offer data is malformed');
    }

    const passengers = rawOffer.passengers.map((passenger): StoredOfferPassenger | null => {
      if (!isRecord(passenger) || typeof passenger.id !== 'string') {
        return null;
      }

      const type = passengerTypeFromRaw(passenger.type);
      return type ? { id: passenger.id, type } : null;
    });

    if (passengers.some((passenger) => passenger === null) || passengers.length === 0) {
      throw new Error('Stored offer passengers are malformed');
    }

    const typedPassengers = passengers as StoredOfferPassenger[];
    const passengerIds = new Set(typedPassengers.map((passenger) => passenger.id));
    if (passengerIds.size !== typedPassengers.length) {
      throw new Error('Stored offer passenger ids are malformed');
    }

    const segments: BookingReadinessSegmentInput[] = [];
    for (const slice of rawOffer.slices) {
      if (!isRecord(slice) || !Array.isArray(slice.segments)) {
        throw new Error('Stored offer slices are malformed');
      }

      for (const segment of slice.segments) {
        if (!isRecord(segment) || !isRecord(segment.origin) || !isRecord(segment.destination)) {
          throw new Error('Stored offer segments are malformed');
        }

        const originCode = iataFromRaw(segment.origin.iata_code);
        const destinationCode = iataFromRaw(segment.destination.iata_code);
        const arrivalDate = dateOnlyFromRaw(segment.arriving_at);
        if (!originCode || !destinationCode || !arrivalDate) {
          throw new Error('Stored offer segment data is malformed');
        }

        segments.push({
          originCountryCode: originCode,
          destinationCountryCode: destinationCode,
          arrivalDate,
        });
      }
    }

    if (segments.length === 0) {
      throw new Error('Stored offer contains no segments');
    }

    const airportCodes = [...new Set(
      segments.flatMap((segment) => [segment.originCountryCode, segment.destinationCountryCode])
        .filter((code): code is string => typeof code === 'string'),
    )];
    const tripCompletionDate = segments.reduce<string | null>(
      (latest, segment) => {
        if (!segment.arrivalDate) {
          return latest;
        }
        return latest === null || segment.arrivalDate > latest ? segment.arrivalDate : latest;
      },
      null,
    );

    if (!tripCompletionDate) {
      throw new Error('Stored offer trip completion is unavailable');
    }

    return { passengers: typedPassengers, segments, airportCodes, tripCompletionDate };
  }

  private assertOfferNotExpired(rawOffer: unknown): void {
    if (!isRecord(rawOffer) || !Object.prototype.hasOwnProperty.call(rawOffer, 'expires_at')) {
      return;
    }

    if (rawOffer.expires_at === null || rawOffer.expires_at === undefined) {
      return;
    }

    if (typeof rawOffer.expires_at !== 'string') {
      throw new Error('Stored offer expiry is malformed');
    }

    const expiresAt = new Date(rawOffer.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error('Stored offer expiry is malformed');
    }

    if (expiresAt.getTime() <= Date.now()) {
      throw httpError('OFFER_EXPIRED', 'Flight offer has expired', HttpStatus.CONFLICT);
    }
  }

  private validatePassengerMappings(
    requestedPassengers: readonly BookingReadinessPassengerDto[],
    storedPassengers: readonly StoredOfferPassenger[],
  ): void {
    const adultCount = requestedPassengers.filter((passenger) => passenger.passengerType === PassengerType.ADULT).length;
    const infantCount = requestedPassengers.filter((passenger) => passenger.passengerType === PassengerType.INFANT).length;
    const requestedIds = requestedPassengers.map((passenger) => passenger.offerPassengerId);
    const storedById = new Map(storedPassengers.map((passenger) => [passenger.id, passenger]));

    if (
      requestedPassengers.length < 1 ||
      requestedPassengers.length > 9 ||
      requestedPassengers.length !== storedPassengers.length ||
      adultCount < 1 ||
      infantCount > adultCount ||
      new Set(requestedIds).size !== requestedIds.length
    ) {
      throw httpError('PASSENGER_MAPPING_INVALID', 'Passenger mapping is invalid', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    for (const requestedPassenger of requestedPassengers) {
      const storedPassenger = storedById.get(requestedPassenger.offerPassengerId);
      if (!storedPassenger || storedPassenger.type !== requestedPassenger.passengerType) {
        throw httpError('PASSENGER_MAPPING_INVALID', 'Passenger mapping is invalid', HttpStatus.UNPROCESSABLE_ENTITY);
      }
    }
  }

  private async resolvePassengers(
    requestedPassengers: readonly BookingReadinessPassengerDto[],
    storedPassengers: readonly StoredOfferPassenger[],
    userId: string,
  ): Promise<BookingReadinessPassengerInput[]> {
    let profile: RawRecord | null = null;
    const passengers: BookingReadinessPassengerInput[] = [];

    for (const passenger of requestedPassengers) {
      const passengerOrdinal = storedPassengers.findIndex((p) => p.id === passenger.offerPassengerId) + 1;
      const source = passenger.source;
      if (source.type === 'inline') {
        passengers.push(inlinePassenger(source, passenger, passengerOrdinal));
        continue;
      }

      if (profile === null) {
        try {
          profile = (await this.profileService.getProfile(userId)) as unknown as RawRecord;
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
            throw httpError('PASSENGER_MAPPING_INVALID', 'Passenger mapping is invalid', HttpStatus.UNPROCESSABLE_ENTITY);
          }
          throw error;
        }
      }

      if (!isRecord(profile) || profile.profileId !== source.travelerProfileId) {
        throw httpError('PASSENGER_MAPPING_INVALID', 'Passenger mapping is invalid', HttpStatus.UNPROCESSABLE_ENTITY);
      }

      passengers.push(profilePassenger(source, profile, passenger, passengerOrdinal));
    }

    return passengers;
  }

  private mapError(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    return httpError(
      'READINESS_DEPENDENCY_UNAVAILABLE',
      'Booking readiness dependency unavailable',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private errorCode(error: HttpException): string {
    const response = error.getResponse();
    if (isRecord(response) && typeof response.code === 'string') {
      return response.code;
    }
    return 'READINESS_REQUEST_FAILED';
  }

  private recordOutcome(
    event: {
      status: string;
      metadata?: Record<string, unknown>;
      error?: boolean;
      operation?: BookingReadinessOperation;
    },
    context: ReadinessContext | undefined,
    startedAt: number,
  ): void {
    try {
      this.bookingReadinessObservability.recordOutcome({
        ...event,
        context,
        latencyMs: Date.now() - startedAt,
      });
    } catch {
      // Observability must never change the advisory endpoint outcome.
    }
  }
}
