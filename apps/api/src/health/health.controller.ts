import { Controller, Get, Res, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '@/prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(@Res() res: Response): Promise<Response> {
    let timeoutId: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Database query timed out')), 100);
    });

    try {
      // Execute the SELECT 1 query and race it with the 100ms timeout
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        timeout,
      ]);

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      return res.status(HttpStatus.OK).json({
        status: 'ok',
        dependencies: {
          database: 'up',
        },
      });
    } catch (error) {
      console.error('[HealthController.check] Error occurred during health check:', error);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'down',
        dependencies: {
          database: 'down',
        },
      });
    }
  }
}
