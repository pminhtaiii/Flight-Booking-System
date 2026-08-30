import { Controller, Get, Req, Res, UseGuards, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from '@shared/types';

interface AuthenticatedUser {
  id?: string;
  sub?: string;
  [key: string]: unknown;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  async getSummary(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DashboardSummary> {
    const userId = req.user?.id || req.user?.sub;

    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new UnauthorizedException('Unauthorized');
    }

    res.setHeader('Cache-Control', 'no-store, private');
    if (typeof res.removeHeader === 'function') {
      res.removeHeader('ETag');
    }

    return this.dashboardService.getSummary(userId);
  }
}
