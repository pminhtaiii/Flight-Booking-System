import { Controller, Get, Res, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelProcessorHealthService } from '../disruption/webhook/duffel-processor-health.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly duffelHealth: DuffelProcessorHealthService,
  ) {}

  @Get()
  async check(@Res() res: Response): Promise<Response> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 100');
          await tx.$queryRaw`SELECT 1`;
        },
        {
          maxWait: 150,
          timeout: 150,
        },
      );

      const processorMetrics = await this.duffelHealth.getHealthMetrics();

      return res.status(HttpStatus.OK).json({
        status: 'ok',
        dependencies: {
          database: 'up',
        },
        processor: processorMetrics,
      });
    } catch (error) {
      this.logger.error('Error occurred during health check:', error);
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'down',
        dependencies: {
          database: 'down',
        },
      });
    }
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
}
