import { Controller, Get, Res, HttpStatus, Logger, Optional } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelProcessorHealthService } from '@/disruption/webhook/duffel-processor-health.service';
import { AgentHealthService } from '@/health/agent-health.service';
import { BookingReadinessMetricsService } from '@/common/observability/booking-readiness.metrics';

@Controller(['health', 'api/health'])
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly duffelHealth: DuffelProcessorHealthService,
    private readonly cacheService: CacheService,
    private readonly agentHealthService: AgentHealthService,
    @Optional() private readonly readinessMetrics?: BookingReadinessMetricsService,
  ) {}

  @Get()
  async check(@Res() res: Response): Promise<Response> {
    let dbStatus: 'up' | 'down' = 'up';
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 500');
          await tx.$queryRaw`SELECT 1`;
        },
        {
          maxWait: 2000,
          timeout: 500,
        },
      );
    } catch (error) {
      this.logger.error('Error occurred during database health check:', error);
      dbStatus = 'down';
    }

    let redisStatus: 'up' | 'down' = 'down';
    try {
      redisStatus = await this.cacheService.checkHealth();
    } catch (error) {
      this.logger.warn('Error occurred during redis health check:', error);
      redisStatus = 'down';
    }

    let processorMetrics: unknown = null;
    try {
      processorMetrics = await this.duffelHealth.getHealthMetrics();
    } catch (error) {
      this.logger.warn('Error occurred during processor health check:', error);
    }

    if (dbStatus === 'down') {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'down',
        dependencies: {
          database: 'down',
          redis: redisStatus,
        },
      });
    }

    if (redisStatus === 'down') {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'degraded',
        dependencies: {
          database: 'up',
          redis: 'down',
        },
        processor: processorMetrics,
      });
    }

    return res.status(HttpStatus.OK).json({
      status: 'ok',
      dependencies: {
        database: 'up',
        redis: 'up',
      },
      processor: processorMetrics,
    });
  }

  @Get('redis')
  async checkRedis(@Res() res: Response): Promise<Response> {
    try {
      const redisStatus = await this.cacheService.checkHealth();
      if (redisStatus === 'up') {
        return res.status(HttpStatus.OK).json({
          status: 'ok',
          dependency: 'redis',
        });
      } else {
        return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
          status: 'down',
          dependency: 'redis',
        });
      }
    } catch (error) {
      this.logger.error('Error occurred during redis endpoint health check:', error);
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'down',
        dependency: 'redis',
      });
    }
  }

  @Get('agent')
  async checkAgent(@Res() res: Response): Promise<Response> {
    const result = await this.agentHealthService.checkAgentHealth();
    if (result.status === 'up') {
      return res.status(HttpStatus.OK).json({
        status: 'ok',
        dependency: 'agent',
        details: result.details,
      });
    }

    return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      status: 'down',
      dependency: 'agent',
      statusCode: result.statusCode,
      details: result.details,
    });
  }

  @Get('processor')
  async checkProcessor(@Res() res: Response): Promise<Response> {
    try {
      const metrics = await this.duffelHealth.getHealthMetrics();
      return res.status(HttpStatus.OK).json(metrics);
    } catch (error) {
      this.logger.error('Error occurred during processor health check:', error);
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'down',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @Get('booking-readiness')
  async getBookingReadiness(@Res() res: Response): Promise<Response> {
    if (!this.readinessMetrics) {
      return res.status(HttpStatus.OK).json({
        status: 'ok',
        dependencies: {
          database: 'up',
          redis: 'up',
        },
        metrics: {},
        latency: {},
        featureFlags: { bookingReadiness: false },
      });
    }
    const snapshot = await this.readinessMetrics.getHealthSnapshot();
    const httpStatus =
      snapshot.status === 'degraded' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;
    return res.status(httpStatus).json(snapshot);
  }

  @Get('ping')
  ping(@Res() res: Response): Response {
    return res.status(HttpStatus.OK).json({ status: 'ok' });
  }
}
