import { Injectable, NotFoundException, Logger, HttpException } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { UserPreferencesDto } from '../dto/user-preferences.dto';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';

@Injectable()
export class TravelerPreferencesService {
  private readonly logger = new Logger(TravelerPreferencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentToolAuditService: AgentToolAuditService,
  ) {}

  private async logToolCall(
    userId: string,
    toolName: string,
    _params: unknown = null,
    startTime: number,
    traceId?: string | null,
    correlationId?: string | null,
    success: boolean = true,
    error: unknown = null,
    response: unknown = null,
  ) {
    const durationMs = Date.now() - startTime;
    const responseSizeBytes = response ? Buffer.byteLength(JSON.stringify(response)) : 0;

    let errorCode: string | null = null;
    if (error) {
      if (error instanceof HttpException) {
        const responseObj = error.getResponse();
        if (
          typeof responseObj === 'object' &&
          responseObj !== null &&
          'code' in responseObj &&
          typeof (responseObj as { code?: unknown }).code === 'string'
        ) {
          errorCode = (responseObj as { code: string }).code;
        } else {
          errorCode = `HTTP_${error.getStatus()}`;
        }
      } else {
        errorCode = 'INTERNAL_ERROR';
      }
    }

    await this.agentToolAuditService.recordToolExecution({
      toolName,
      actorId: userId,
      outcome: success ? 'SUCCESS' : 'FAILURE',
      durationMs,
      responseSizeBytes,
      occurredAt: new Date().toISOString(),
      errorCode: errorCode || undefined,
      traceId: traceId || undefined,
      correlationId: correlationId || undefined,
    });
  }

  async getUserPreferences(
    userId: string,
    traceId?: string | null,
    correlationId?: string | null,
  ): Promise<UserPreferencesDto> {
    const startTime = Date.now();
    try {
      // Exclude passportNumber and passportExpiry at query level via Prisma select
      const profile = await this.prisma.travelerProfile.findUnique({
        where: { userId },
        select: {
          seatPreference: true,
          classPreference: true,
          preferredAirlines: true,
          blacklistedAirlines: true,
          dietaryNeeds: true,
        },
      });

      if (!profile) {
        throw new NotFoundException({
          statusCode: 404,
          message: 'No traveler profile exists for this user',
          code: 'PROFILE_NOT_FOUND',
        });
      }

      await this.logToolCall(
        userId,
        'users/preferences',
        {},
        startTime,
        traceId,
        correlationId,
        true,
        null,
        profile,
      );
      return profile;
    } catch (err) {
      await this.logToolCall(
        userId,
        'users/preferences',
        {},
        startTime,
        traceId,
        correlationId,
        false,
        err,
        null,
      );
      throw err;
    }
  }
}
