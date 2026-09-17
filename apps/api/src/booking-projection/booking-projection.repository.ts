import { Injectable } from '@nestjs/common';
import { Prisma, BookingAgentProjection } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { SafeBookingProjectionData } from './booking-projection.service';

export type ProjectionUpsertOutcome = 'SUCCESS' | 'STALE_IGNORED';

export interface ProjectionUpsertResult {
  outcome: ProjectionUpsertOutcome;
}

export interface UpsertGuardedParams {
  bookingId: string;
  status: string;
  sourceVersion: number;
  airline?: string;
  origin?: string;
  destination?: string;
  departureAt?: Date;
  arrivalAt?: Date;
  durationMinutes?: number;
  stopCount?: number;
  flightNumber?: string | null;
  baggageSummary?: string | null;
  refundable?: boolean | null;
  changeable?: boolean | null;
  agentReference?: string;
  data?: SafeBookingProjectionData;
}

@Injectable()
export class BookingProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  generateAgentReference(): string {
    return `bkref_${crypto.randomUUID()}`;
  }

  async upsertGuarded(
    params: UpsertGuardedParams,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<ProjectionUpsertResult> {
    const prismaClient = client || this.prisma;
    const agentReference = params.agentReference || this.generateAgentReference();

    const data = params.data || params;
    const airline = data.airline ?? '';
    const origin = data.origin ?? '';
    const destination = data.destination ?? '';
    const departureAt =
      data.departureAt instanceof Date ? data.departureAt : new Date(data.departureAt ?? 0);
    const arrivalAt =
      data.arrivalAt instanceof Date ? data.arrivalAt : new Date(data.arrivalAt ?? 0);
    const durationMinutes = data.durationMinutes ?? 0;
    const stopCount = data.stopCount ?? 0;
    const flightNumber = data.flightNumber ?? null;
    const baggageSummary = data.baggageSummary ?? null;
    const refundable = data.refundable ?? null;
    const changeable = data.changeable ?? null;
    const status = params.status;
    const bookingId = params.bookingId;
    const sourceVersion = params.sourceVersion;

    const rowsAffected = await prismaClient.$executeRaw`
      INSERT INTO "booking_agent_projections" (
        "bookingId", "agentReference", "status", "airline", "origin", "destination",
        "departureAt", "arrivalAt", "durationMinutes", "stopCount", "flightNumber",
        "baggageSummary", "refundable", "changeable", "source_version", "createdAt", "updatedAt"
      ) VALUES (
        ${bookingId}, ${agentReference}, ${status}, ${airline}, ${origin}, ${destination},
        ${departureAt}, ${arrivalAt}, ${durationMinutes}, ${stopCount}, ${flightNumber},
        ${baggageSummary}, ${refundable}, ${changeable}, ${sourceVersion}, NOW(), NOW()
      )
      ON CONFLICT ("bookingId") DO UPDATE
      SET "status" = EXCLUDED."status",
          "airline" = EXCLUDED."airline",
          "origin" = EXCLUDED."origin",
          "destination" = EXCLUDED."destination",
          "departureAt" = EXCLUDED."departureAt",
          "arrivalAt" = EXCLUDED."arrivalAt",
          "durationMinutes" = EXCLUDED."durationMinutes",
          "stopCount" = EXCLUDED."stopCount",
          "flightNumber" = EXCLUDED."flightNumber",
          "baggageSummary" = EXCLUDED."baggageSummary",
          "refundable" = EXCLUDED."refundable",
          "changeable" = EXCLUDED."changeable",
          "source_version" = EXCLUDED."source_version",
          "updatedAt" = NOW()
      WHERE "booking_agent_projections"."source_version" < EXCLUDED."source_version";
    `;

    if (rowsAffected > 0) {
      return { outcome: 'SUCCESS' };
    }
    return { outcome: 'STALE_IGNORED' };
  }

  async upsertProjection(
    params: UpsertGuardedParams,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<ProjectionUpsertResult> {
    return this.upsertGuarded(params, client);
  }

  async findByBookingId(
    bookingId: string,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<BookingAgentProjection | null> {
    const prismaClient = client || this.prisma;
    return prismaClient.bookingAgentProjection.findUnique({
      where: { bookingId },
    });
  }

  async findByReferenceAndUserId(
    agentReference: string,
    userId: string,
    client?: Prisma.TransactionClient | PrismaService,
  ): Promise<BookingAgentProjection | null> {
    const prismaClient = client || this.prisma;
    const projection = await prismaClient.bookingAgentProjection.findUnique({
      where: { agentReference },
      include: {
        booking: {
          select: { userId: true },
        },
      },
    });

    const projectionWithUser = projection as (BookingAgentProjection & {
      booking?: { userId?: string };
    }) | null;

    if (!projectionWithUser || projectionWithUser.booking?.userId !== userId) {
      return null;
    }

    return projection;
  }
}
